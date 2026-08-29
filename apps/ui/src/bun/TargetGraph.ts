import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { readdir, readFile } from "node:fs/promises"
import { dirname, join, relative, sep } from "node:path"
import type { GraphEdge, GraphNode, TargetGraphResponse } from "smithers-shared/TargetGraph"
import { splitLabel } from "smithers-shared/LocalApp"
import type { NodeSidecar } from "./Node"
import { currentSandboxHost, loaderPolicy, wrapSandbox } from "./Sandbox"
import type { SandboxHost } from "./Sandbox"
import { QUERY_TIMEOUT_MS, queryTargets, resolveBuildCli, sandboxPathsFor } from "./Targets"

type JsonObject = Record<string, unknown>

const object = (value: unknown): JsonObject | undefined =>
  typeof value === "object" && value !== null ? value as JsonObject : undefined

const strings = (value: unknown): Array<string> | undefined =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : undefined

export const parseTextGraph = (
  text: string,
  rows: ReadonlyArray<{ readonly label: string; readonly rule?: string; readonly target?: string; readonly kinds?: ReadonlyArray<string> }> = []
): { readonly nodes: Array<GraphNode>; readonly edges: Array<GraphEdge> } => {
  const rowByLabel = new Map(rows.map((row) => [row.label, row]))
  const labels = new Set<string>()
  const edges: Array<GraphEdge> = []
  let from: string | undefined
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === "") continue
    const edge = /^\s+-\s*(data|gates|services|deps)\s*->\s*(\/\/\S+)\s*$/.exec(line)
    if (edge !== null && from !== undefined) {
      const to = edge[2]!
      labels.add(to)
      edges.push({ from, to, kind: edge[1] as GraphEdge["kind"] })
      continue
    }
    const label = /^(\/\/\S+)\s*$/.exec(line)?.[1]
    if (label !== undefined) {
      from = label
      labels.add(label)
    }
  }
  for (const row of rows) labels.add(row.label)
  const nodes = [...labels].map((label): GraphNode => {
    const row = rowByLabel.get(label)
    const parts = splitLabel(label)
    return {
      label,
      ...parts,
      rule: row?.rule ?? row?.target ?? "",
      kinds: [...(row?.kinds ?? [])],
      private: parts.name.startsWith("__private_")
    }
  })
  return { nodes, edges }
}

export const foldPlan = (nodes: ReadonlyArray<GraphNode>, envelopes: ReadonlyArray<unknown>): Array<GraphNode> => {
  const plans = new Map<string, GraphNode["plan"]>()
  for (const envelope of envelopes) {
    const targets = object(envelope)?.targets
    if (!Array.isArray(targets)) continue
    for (const value of targets) {
      const row = object(value)
      if (row === undefined || typeof row.label !== "string") continue
      const mode = row.mode === "execute" || row.mode === "check" || row.mode === "write" ? row.mode : undefined
      const plan: NonNullable<GraphNode["plan"]> = {
        ...(mode === undefined ? {} : { mode }),
        ...(typeof row.cacheable === "boolean" ? { cacheable: row.cacheable } : {}),
        ...(typeof row.key === "string" ? { key: row.key } : {}),
        ...(typeof row.refusal === "string" ? { refusal: row.refusal } : {}),
        ...(strings(row.argv) === undefined ? {} : { argv: strings(row.argv)! }),
        ...(typeof row.sandbox === "string" ? { sandbox: row.sandbox } : {}),
        ...(strings(row.outDirs) === undefined ? {} : { outDirs: strings(row.outDirs)! }),
        ...(strings(row.outFiles) === undefined ? {} : { outFiles: strings(row.outFiles)! }),
        ...(strings(row.inputs) === undefined ? {} : { inputs: strings(row.inputs)! })
      }
      plans.set(row.label, plan)
    }
  }
  return nodes.map((node) => plans.has(node.label) ? { ...node, plan: plans.get(node.label) } : { ...node })
}

const SKIPPED_DIRS = [".git", ".flows", "node_modules", "dist", "build"]
const DECLARATION_FILES = ["PACKAGE.ts", "WORKSPACE.ts", "BUILD.ts"]

/** The declaration set of a workspace: a content digest plus each labeled const's declaration site. */
export interface DeclarationSet {
  readonly digest: string
  readonly sources: ReadonlyMap<string, GraphNode["source"]>
}

/*
 * Fingerprints the workspace's declarations, ASYNCHRONOUSLY, by content.
 *
 * This runs on every graph/affected/ci request - it is what makes a graph go
 * stale the instant a declaration is edited - so it walks the whole source
 * tree. Done with synchronous fs calls it measured 160-190ms of blocked event
 * loop per request on ~/artsy/force, during which the server answered nothing
 * and no frame of a streaming run reached a live overlay. Sibling directories
 * are walked concurrently, file contents are read in modest batches so the
 * loop breathes, and the digest is fed in sorted path order so it stays
 * stable whatever order the filesystem and the scheduler answer in. Hashing
 * contents (not mtime/size) means an edit that keeps size and mtime still
 * re-keys the graph; the same pass records where each labeled const is
 * declared for the drawer's "open declaration" affordance.
 */
const declarationSet = async (repo: string): Promise<DeclarationSet> => {
  const found: Array<string> = []
  const walk = async (dir: string): Promise<void> => {
    let entries: Array<import("node:fs").Dirent>
    try { entries = await readdir(dir, { withFileTypes: true }) } catch { return }
    await Promise.all(entries.map(async (entry) => {
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.includes(entry.name)) await walk(join(dir, entry.name))
        return
      }
      if (entry.isFile() && DECLARATION_FILES.includes(entry.name)) found.push(join(dir, entry.name))
    }))
  }
  await walk(repo)
  found.sort((left, right) => left.localeCompare(right))
  const contents = new Map<string, string>()
  const BATCH = 64
  for (let offset = 0; offset < found.length; offset += BATCH) {
    await Promise.all(found.slice(offset, offset + BATCH).map(async (path) => {
      try { contents.set(path, await readFile(path, "utf8")) } catch { /* A declaration that vanished mid-walk is simply not in the graph. */ }
    }))
  }
  const hash = createHash("sha256")
  const sources = new Map<string, GraphNode["source"]>()
  for (const path of found) {
    const text = contents.get(path)
    if (text === undefined) continue
    const file = relative(repo, path).split(sep).join("/")
    hash.update(file).update("\0").update(text).update("\0")
    if (path.endsWith("PACKAGE.ts") || path.endsWith("BUILD.ts")) {
      const packageDir = dirname(file) === "." ? "" : dirname(file)
      for (const match of text.matchAll(/^[\t ]*(?:export[\t ]+)?const[\t ]+([A-Za-z_$][\w$]*)[\t ]*=/gm)) {
        const line = text.slice(0, match.index).split("\n").length
        sources.set(`//${packageDir}:${match[1]}`, { file, line })
      }
    }
  }
  return { digest: hash.digest("hex"), sources }
}

interface CachedGraph { readonly digest: string; readonly response: TargetGraphResponse }
const graphCache = new Map<string, CachedGraph>()
export const clearTargetGraphCache = (): void => graphCache.clear()

export interface TargetGraphOptions {
  readonly repoId: string
  readonly repo: string
  readonly node: NodeSidecar | null
  readonly plan?: boolean
  readonly labels?: ReadonlyArray<string>
  readonly cli?: string
  readonly sandboxHost?: SandboxHost
  readonly timeoutMs?: number
}

const runJson = async (options: TargetGraphOptions, args: ReadonlyArray<string>): Promise<unknown> => {
  if (options.node === null) throw new Error("No Node.js >= 22.19 was found for the smthrs loader.")
  const cli = options.cli ?? resolveBuildCli()
  if (!existsSync(cli)) throw new Error(`The smthrs loader is missing at ${cli}.`)
  const wrapped = wrapSandbox(
    [options.node.path, cli, ...args],
    loaderPolicy(sandboxPathsFor(options.repo)),
    options.sandboxHost ?? currentSandboxHost()
  )
  const child = Bun.spawn([...wrapped.argv], { cwd: options.repo, stdout: "pipe", stderr: "pipe", stdin: "ignore" })
  const timer = setTimeout(() => child.kill(), options.timeoutMs ?? QUERY_TIMEOUT_MS)
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout as ReadableStream).text(),
    new Response(child.stderr as ReadableStream).text()
  ])
  clearTimeout(timer)
  if (code !== 0) throw new Error(`The loader exited ${code}: ${stderr.trim().slice(0, 2000)}`)
  try { return JSON.parse(stdout) } catch { throw new Error(`The loader did not answer JSON: ${stdout.trim().slice(0, 200)}`) }
}

export const queryTargetGraph = async (options: TargetGraphOptions): Promise<TargetGraphResponse> => {
  const started = Date.now()
  const declarations = await declarationSet(options.repo)
  const digest = declarations.digest
  let base = graphCache.get(options.repo)
  if (base === undefined || base.digest !== digest) {
    const [envelope, targetResult] = await Promise.all([
      runJson(options, ["graph", "//...", "--format", "json"]),
      queryTargets({ repo: options.repo, node: options.node, ...(options.cli === undefined ? {} : { cli: options.cli }), ...(options.sandboxHost === undefined ? {} : { sandboxHost: options.sandboxHost }), ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }) })
    ])
    const body = object(envelope)
    if (typeof body?.graph !== "string") throw new Error("The graph envelope has no text graph field.")
    const rows = Array.isArray(body.targets)
      ? body.targets.map(object).filter((row): row is JsonObject => row !== undefined).filter((row) => typeof row.label === "string").map((row) => ({ label: row.label as string, target: typeof row.target === "string" ? row.target : "", kinds: strings(row.kinds) ?? [] }))
      : []
    const merged = new Map(rows.map((row) => [row.label, row]))
    for (const target of targetResult.targets) merged.set(target.label, { label: target.label, target: target.target, kinds: target.kinds })
    const parsed = parseTextGraph(body.graph, [...merged.values()])
    const nodes = parsed.nodes.map((node) => {
      const source = declarations.sources.get(node.label)
      return source === undefined ? node : { ...node, source }
    })
    const generatedAt = new Date().toISOString()
    /*
     * `digest` is the field a card compares to decide whether its cached
     * graph went stale after a declaration edit; it has to reach the UI, not
     * just this cache, or the documented staleness check can never fire.
     */
    base = { digest, response: { repoId: options.repoId, nodes, edges: parsed.edges, warnings: targetResult.warnings, generatedAt, digest, durationMs: Date.now() - started } }
    graphCache.set(options.repo, base)
  }
  let nodes = base.response.nodes.map((node) => ({ ...node, kinds: [...node.kinds], ...(node.plan === undefined ? {} : { plan: { ...node.plan } }) }))
  if (options.plan === true) {
    const labels = options.labels?.length ? options.labels : ["//..."]
    const envelopes = await Promise.all(labels.map((label) => runJson(options, [label, "--plan", "--format", "json"])))
    nodes = foldPlan(nodes, envelopes)
  }
  return { ...base.response, repoId: options.repoId, nodes, edges: base.response.edges.map((edge) => ({ ...edge })), durationMs: Date.now() - started }
}
