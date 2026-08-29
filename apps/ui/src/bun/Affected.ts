import { readFile } from "node:fs/promises"
import { join, posix } from "node:path"
import { reachable } from "smithers-shared/TargetGraph"
import type { AffectedResponse, GraphEdge, GraphNode } from "smithers-shared/TargetGraph"

export interface DeclaredInput { readonly pattern: string; readonly source: "plan" | "declaration" }
export type DeclaredInputs = ReadonlyMap<string, ReadonlyArray<DeclaredInput>>

const labelFor = (packageDir: string, name: string): string => packageDir === "" ? `//:${name}` : `//${packageDir}:${name}`
const normalizePattern = (packageDir: string, pattern: string): string => {
  if (pattern.startsWith("//")) return pattern.slice(2)
  return posix.join(packageDir, pattern)
}

/** Best-effort static extraction of S.file/S.glob inputs and local data references. */
export const declarationInputs = async (repo: string, files: ReadonlyArray<string>): Promise<DeclaredInputs> => {
  /*
   * This runs inside the affected route's handler, so the reads are async:
   * a monorepo-scale declaration set read with readFileSync is one unbroken
   * block of the server's event loop (AffectedBlocking.test.ts holds a 10ms
   * heartbeat across it). Reads go in modest batches — fast, and the loop
   * breathes between files.
   */
  const sources = new Map<string, string>()
  const BATCH = 64
  for (let offset = 0; offset < files.length; offset += BATCH) {
    await Promise.all(files.slice(offset, offset + BATCH).map(async (file) => {
      try { sources.set(file, await readFile(join(repo, file), "utf8")) } catch { /* An unreadable declaration contributes nothing. */ }
    }))
  }
  const result = new Map<string, Array<DeclaredInput>>()
  for (const file of files) {
    const source = sources.get(file)
    if (source === undefined) continue
    const packageDir = posix.dirname(file) === "." ? "" : posix.dirname(file)
    const definitions = new Map<string, string>()
    const starts = [...source.matchAll(/^const\s+([A-Za-z_$][\w$]*)\s*=/gm)]
    for (let index = 0; index < starts.length; index++) {
      const match = starts[index]!
      definitions.set(match[1]!, source.slice(match.index!, starts[index + 1]?.index ?? source.length))
    }
    const memo = new Map<string, Array<string>>()
    const inputsFor = (name: string, visiting = new Set<string>()): Array<string> => {
      const known = memo.get(name)
      if (known !== undefined) return known
      if (visiting.has(name)) return []
      visiting.add(name)
      const block = definitions.get(name) ?? ""
      const direct: Array<string> = []
      for (const match of block.matchAll(/S\.file\(\s*["']([^"']+)["']/g)) direct.push(match[1]!)
      for (const match of block.matchAll(/S\.glob\(\s*\[([\s\S]*?)\]/g)) {
        for (const quoted of match[1]!.matchAll(/["']([^"']+)["']/g)) if (!quoted[1]!.startsWith("!")) direct.push(quoted[1]!)
      }
      for (const ref of definitions.keys()) {
        if (ref !== name && new RegExp(`\\b${ref}\\b`).test(block)) direct.push(...inputsFor(ref, new Set(visiting)))
      }
      const values = [...new Set(direct.map((pattern) => normalizePattern(packageDir, pattern)))]
      memo.set(name, values)
      return values
    }
    for (const name of definitions.keys()) {
      const values = inputsFor(name)
      if (values.length > 0) result.set(labelFor(packageDir, name), values.map((pattern) => ({ pattern, source: "declaration" })))
    }
    // A declaration edit can change any target declared by that package.
    for (const name of definitions.keys()) {
      const label = labelFor(packageDir, name)
      result.set(label, [...(result.get(label) ?? []), { pattern: file, source: "declaration" }])
    }
  }
  return result
}

const globRegex = (pattern: string): RegExp => {
  let value = ""
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]!
    if (char === "*") {
      if (pattern[i + 1] === "*") { value += ".*"; i++ } else value += "[^/]*"
    } else if (char === "?") value += "[^/]"
    else value += char.replace(/[|\\{}()[\]^$+?.]/g, "\\$&")
  }
  return new RegExp(`^${value}(?:/.*)?$`)
}

export const computeAffected = (options: {
  readonly repoId: string
  readonly base: string
  readonly changedFiles: ReadonlyArray<string>
  readonly nodes: ReadonlyArray<GraphNode>
  readonly edges: ReadonlyArray<GraphEdge>
  readonly declarations: DeclaredInputs
  readonly durationMs?: number
}): AffectedResponse => {
  const direct = new Map<string, Array<string>>()
  for (const node of options.nodes) {
    const declared = [...(options.declarations.get(node.label) ?? [])]
    for (const input of node.plan?.inputs ?? []) declared.push({ pattern: input.replace(/^\.\//, ""), source: "plan" })
    const matches = options.changedFiles.filter((file) => declared.some((input) => globRegex(input.pattern).test(file)))
    if (matches.length > 0) direct.set(node.label, matches)
  }
  const affected = new Map<string, string>()
  for (const [label, files] of direct) {
    affected.set(label, `declared input: ${files.join(", ")}`)
    for (const dependent of reachable(options.edges, label, "rdeps")) {
      if (!affected.has(dependent)) affected.set(dependent, `transitive via ${label}`)
    }
  }
  return {
    repoId: options.repoId,
    base: options.base,
    changedFiles: [...options.changedFiles].sort(),
    affected: [...affected].map(([label, reason]) => ({ label, reason })).sort((a, b) => a.label.localeCompare(b.label)),
    signal: "git status/diff + plan inputs when present + static S.file/S.glob declaration inputs + reverse graph reachability",
    limits: ["Computed/glob inputs hidden behind arbitrary TypeScript cannot be recovered without a CLI plan input list."],
    durationMs: options.durationMs ?? 0
  }
}

const git = async (repo: string, args: ReadonlyArray<string>): Promise<string> => {
  const child = Bun.spawn(["git", "-C", repo, ...args], { stdout: "pipe", stderr: "pipe", stdin: "ignore" })
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  if (code !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr.trim()}`)
  return stdout.trim()
}

export const changedFiles = async (repo: string): Promise<{ readonly base: string; readonly files: Array<string> }> => {
  const [base, status, diff] = await Promise.all([
    git(repo, ["rev-parse", "HEAD"]),
    git(repo, ["status", "--porcelain=v1", "--untracked-files=all"]),
    git(repo, ["diff", "--name-only", "HEAD"])
  ])
  const files = new Set(diff.split(/\r?\n/).filter(Boolean))
  for (const line of status.split(/\r?\n/)) {
    if (line.length < 4) continue
    const path = line.slice(3).trim()
    files.add(path.includes(" -> ") ? path.split(" -> ").pop()! : path)
  }
  return { base, files: [...files] }
}
