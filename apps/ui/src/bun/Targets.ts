/*
 * Targets through the Node sidecar (LOCAL-APP.md, "Targets: load and run").
 * The loader is the existing build-cli, run under the loader sandbox policy;
 * its JSON listing maps 1:1 onto `Target`. A run streams the CLI's stdout,
 * stderr and exit as frames on the `target-run:<runId>` WebSocket topic.
 */
import { existsSync, realpathSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import type { RepoWorkspace, TargetDefinition } from "smithers-shared/LocalApp"
import { splitLabel } from "smithers-shared/LocalApp"
import { criticalPath } from "smithers-shared/TargetGraph"
import type { GraphEdge, NodeTiming, RunSummary, TargetRunEvent } from "smithers-shared/TargetGraph"
import type { NodeSidecar } from "./Node"
import { currentSandboxHost, loaderPolicy, wrapSandbox } from "./Sandbox"
import type { SandboxHost, SandboxPaths } from "./Sandbox"

/** How long the loader may take before the query answers with a warning. */
export const QUERY_TIMEOUT_MS = 120_000

/**
 * The build-cli entry: SMITHERS_BUILD_CLI, else the nearest
 * packages/build-cli/src/main.js above this file. In the source tree that is
 * four levels up (apps/ui/src/bun); under `electrobun dev` and in a built
 * bundle this file runs from apps/ui/build/<target>/<App>.app/..., so the
 * walk keeps climbing until it leaves the bundle and reaches the checkout.
 * When nothing exists on disk, the four-level path is returned so the
 * missing-loader warning names where it was expected.
 */
export const resolveBuildCli = (
  env: Readonly<Record<string, string | undefined>> = Bun.env,
  fromDir: string = import.meta.dir,
  exists: (path: string) => boolean = existsSync
): string => {
  const explicit = env.SMITHERS_BUILD_CLI?.trim()
  if (explicit !== undefined && explicit !== "") return resolve(explicit)
  const fallback = resolve(fromDir, "..", "..", "..", "..", "packages", "build-cli", "src", "main.js")
  let dir = resolve(fromDir)
  while (true) {
    const candidate = resolve(dir, "packages", "build-cli", "src", "main.js")
    if (exists(candidate)) return candidate
    const parent = dirname(dir)
    if (parent === dir) return fallback
    dir = parent
  }
}

/**
 * The paths the loader policy is built from. The temp dir is canonicalised:
 * seatbelt matches subpaths against real paths, and macOS hands out
 * /var/folders/... for /private/var/folders/..., which the profile would
 * otherwise deny.
 */
export const sandboxPathsFor = (repo: string): SandboxPaths => {
  let tmp = tmpdir()
  try {
    tmp = realpathSync(tmp)
  } catch {
    // The unresolved path is still the right one to allow.
  }
  return { repo, home: homedir(), tmpdir: tmp }
}

const isTargetRow = (value: unknown): value is { label: string; target?: unknown; kinds?: unknown } =>
  typeof value === "object" && value !== null && typeof (value as { label?: unknown }).label === "string"

/**
 * The loader's `{ targets: [{ label, target, kinds }] }` listing as Targets
 * tagged with the workspace the loader ran in, or an error message when the
 * text is not that shape.
 */
export const mapTargets = (stdout: string, workspace: string): { readonly targets: Array<TargetDefinition> } | { readonly error: string } => {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    return { error: `The loader did not answer JSON: ${stdout.trim().slice(0, 200)}` }
  }
  if (typeof parsed !== "object" || parsed === null) return { error: "The loader answered a non-object." }
  const body = parsed as { targets?: unknown; message?: unknown; code?: unknown }
  if (!Array.isArray(body.targets)) {
    const message = typeof body.message === "string" ? body.message : "no targets[] in the loader's answer"
    return { error: typeof body.code === "string" ? `${body.code}: ${message}` : message }
  }
  return {
    targets: body.targets.filter(isTargetRow).map((row) => ({
      label: row.label,
      target: typeof row.target === "string" ? row.target : "",
      kinds: Array.isArray(row.kinds) ? row.kinds.filter((kind): kind is string => typeof kind === "string") : [],
      ...splitLabel(row.label),
      workspace
    }))
  }
}

export interface TargetsQueryResult {
  readonly targets: Array<TargetDefinition>
  readonly warnings: Array<string>
  readonly durationMs: number
}

export interface TargetsQueryOptions {
  readonly repo: string
  /**
   * The detected workspaces the query fans out over (one loader run each,
   * cwd = join(repo, workspace.path)). Absent or empty queries the root alone.
   */
  readonly workspaces?: ReadonlyArray<RepoWorkspace>
  readonly node: NodeSidecar | null
  readonly cli?: string
  readonly sandboxHost?: SandboxHost
  readonly timeoutMs?: number
}

/** The directory a workspace's loader (and runner) executes in. */
export const workspaceCwd = (repo: string, workspace: string): string =>
  workspace === "." ? repo : join(repo, workspace)

/** One loader run at one workspace's cwd; errors come back as warnings, never a throw. */
const queryWorkspace = async (
  options: TargetsQueryOptions & { readonly node: NodeSidecar; readonly cli: string },
  workspace: string
): Promise<{ readonly targets: Array<TargetDefinition>; readonly warnings: Array<string> }> => {
  const warnings: Array<string> = []
  const cwd = workspaceCwd(options.repo, workspace)
  const wrapped = wrapSandbox(
    [options.node.path, options.cli, "query", "//...", "--format", "json"],
    loaderPolicy(sandboxPathsFor(cwd)),
    options.sandboxHost ?? currentSandboxHost()
  )
  let child: ReturnType<typeof Bun.spawn>
  try {
    child = Bun.spawn([...wrapped.argv], { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore" })
  } catch (error) {
    return { targets: [], warnings: [`The loader could not start: ${error instanceof Error ? error.message : String(error)}`] }
  }
  const timer = setTimeout(() => child.kill(), options.timeoutMs ?? QUERY_TIMEOUT_MS)
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout as ReadableStream).text(),
    new Response(child.stderr as ReadableStream).text()
  ])
  clearTimeout(timer)
  const mapped = mapTargets(stdout, workspace)
  if ("error" in mapped) {
    warnings.push(code === 0 ? mapped.error : `The loader exited ${code}: ${mapped.error}`)
    const trimmed = stderr.trim()
    if (trimmed !== "") warnings.push(trimmed.slice(0, 2000))
    return { targets: [], warnings }
  }
  if (code !== 0) warnings.push(`The loader exited ${code}.`)
  return { targets: mapped.targets, warnings }
}

/**
 * `node <cli> query '//...' --format json` once per detected workspace, each
 * at its own cwd under the loader policy and each with its own timeout. One
 * workspace's failure is a warning and never blocks the others.
 */
export const queryTargets = async (options: TargetsQueryOptions): Promise<TargetsQueryResult> => {
  const started = Date.now()
  const cli = options.cli ?? resolveBuildCli()
  const warnings: Array<string> = []
  const node = options.node
  if (node === null) {
    warnings.push("No Node.js >= 22.19 was found for the smthrs loader (SMITHERS_NODE, PATH, nvm, homebrew).")
    return { targets: [], warnings, durationMs: Date.now() - started }
  }
  if (!existsSync(cli)) {
    warnings.push(`The smthrs loader is missing at ${cli} (set SMITHERS_BUILD_CLI).`)
    return { targets: [], warnings, durationMs: Date.now() - started }
  }
  const workspaces = options.workspaces === undefined || options.workspaces.length === 0
    ? ["."]
    : options.workspaces.map((workspace) => workspace.path)
  // A lone root query keeps the historical, unprefixed warning text.
  const lone = workspaces.length === 1 && workspaces[0] === "."
  const settled = await Promise.all(
    workspaces.map(async (workspace) => ({ workspace, ...(await queryWorkspace({ ...options, node, cli }, workspace)) }))
  )
  const targets: Array<TargetDefinition> = []
  for (const result of settled) {
    targets.push(...result.targets)
    for (const warning of result.warnings) warnings.push(lone ? warning : `[${result.workspace}] ${warning}`)
  }
  return { targets, warnings, durationMs: Date.now() - started }
}

export type TargetRunStatus = "pending" | "running" | "done" | "failed"

export interface TargetRun {
  readonly runId: string
  readonly repoId: string
  readonly repo: string
  /** The detected workspace the run executes in ("." for the repo root). */
  readonly workspace: string
  readonly label: string
  readonly labels: ReadonlyArray<string>
  readonly startedAt: number
  status: TargetRunStatus
  exitCode: number | null
}

export interface TargetRunnerOptions {
  readonly publish: (topic: string, message: unknown) => void
  readonly cli?: string
  /** A run nobody attached to starts on its own after this long. */
  readonly autoStartMs?: number
  readonly log?: (line: string) => void
  readonly onEvent?: (run: TargetRun, event: TargetRunEvent) => void
  /** Maximum pending/running children; default 4. */
  readonly maxActiveRuns?: number
  /** Maximum retained run handles; settled handles are evicted oldest-first. */
  readonly maxRetainedRuns?: number
}

export class TargetRunCapacityError extends Error {
  readonly code = "target_run_capacity"
}

export interface TargetRunner {
  /** Registers a run; the child starts on `attach`, or after `autoStartMs`. */
  readonly start: (run: {
    readonly repoId: string
    readonly repo: string
    readonly workspace: string
    readonly label: string
    readonly node: NodeSidecar; readonly edges?: ReadonlyArray<GraphEdge> }) => TargetRun
  /** A subscriber is listening: spawn now if not yet started. */
  readonly attach: (runId: string) => boolean
  readonly cancel: (runId: string) => boolean
  readonly get: (runId: string) => TargetRun | undefined
  readonly stop: () => void
}

export const runTopic = (runId: string): string => `target-run:${runId}`

const durationMs = (amount: string | undefined, unit: string | undefined): number | undefined => {
  if (amount === undefined) return undefined
  const number = Number(amount)
  if (!Number.isFinite(number)) return undefined
  return Math.round(unit === "s" ? number * 1000 : number)
}

export interface RunStdoutParser {
  readonly push: (type: "stdout" | "stderr", data: string, at?: number) => ReadonlyArray<TargetRunEvent>
  readonly finish: (at?: number) => ReadonlyArray<TargetRunEvent>
  readonly timings: () => ReadonlyArray<NodeTiming>
  readonly summary: () => RunSummary | undefined
}

/** Incrementally parses stable executor status/summary lines and JSON envelopes. */
export const createRunStdoutParser = (options: {
  readonly edges?: ReadonlyArray<GraphEdge>
  readonly startedAt: number
}): RunStdoutParser => {
  const buffers: Record<"stdout" | "stderr", string> = { stdout: "", stderr: "" }
  const nodes = new Map<string, NodeTiming>()
  let lastSummary: RunSummary | undefined
  const timing = (row: {
    readonly label: string
    readonly status: NodeTiming["status"]
    readonly at: number
    readonly startedAt?: number
    readonly endedAt?: number
    readonly durationMs?: number
    readonly key?: string
    readonly reason?: string
  }): NodeTiming => {
    const prior = nodes.get(row.label)
    const settled = !["pending", "running"].includes(row.status)
    const endedAt = settled ? row.endedAt ?? row.at : undefined
    const startedAt = row.startedAt ?? prior?.startedAt ?? (
      settled ? (endedAt ?? row.at) - (row.durationMs ?? 0) : row.status === "running" ? row.at : undefined
    )
    return {
      label: row.label,
      status: row.status,
      ...(startedAt === undefined ? {} : { startedAt }),
      ...(endedAt === undefined ? {} : { endedAt }),
      ...(settled ? { durationMs: endedAt! - startedAt! } : {}),
      ...(row.key === undefined ? {} : { key: row.key }),
      ...(row.reason === undefined ? {} : { reason: row.reason })
    }
  }
  const parseSummary = (line: string, at: number): TargetRunEvent | undefined => {
    const head = /^\s*(\d+)\s+targets?:\s*(.*)$/i.exec(line)
    if (head === null) return undefined
    const rest = head[2]!
    const count = (status: string): number => Number(new RegExp(`(?:^|[,;]\\s*)?(\\d+)\\s+${status}\\b`, "i").exec(rest)?.[1] ?? 0)
    const elapsed = /\((\d+(?:\.\d+)?)\s*(ms|s)\)\s*$/.exec(rest)
    const failed = count("failed") + count("refused")
    lastSummary = {
      total: Number(head[1]), hit: count("hit"), ran: count("ran"), failed, skipped: count("skipped"),
      durationMs: durationMs(elapsed?.[1], elapsed?.[2]) ?? at - options.startedAt,
      ok: failed === 0,
      criticalPath: [...criticalPath([...nodes.values()], options.edges ?? [])]
    }
    return { type: "summary", summary: lastSummary, at }
  }
  const parseObject = (line: string, at: number): Array<TargetRunEvent> => {
    if (!line.trimStart().startsWith("{")) return []
    let value: unknown
    try { value = JSON.parse(line) } catch { return [] }
    if (typeof value !== "object" || value === null) return []
    const body = value as { targets?: unknown; summary?: unknown }
    if (!Array.isArray(body.targets)) return []
    const events: Array<TargetRunEvent> = []
    for (const item of body.targets) {
      if (typeof item !== "object" || item === null) continue
      const row = item as Record<string, unknown>
      if (typeof row.label !== "string" || typeof row.status !== "string") continue
      if (!["pending", "running", "hit", "ran", "failed", "skipped", "refused", "cancelled"].includes(row.status)) continue
      const ms = typeof row.durationMs === "number" ? row.durationMs : undefined
      const node = timing({
        label: row.label,
        status: row.status as NodeTiming["status"],
        at,
        ...(typeof row.startedAt === "number" ? { startedAt: row.startedAt } : {}),
        ...(typeof row.endedAt === "number" ? { endedAt: row.endedAt } : {}),
        ...(ms === undefined ? {} : { durationMs: ms }),
        ...(typeof row.key === "string" ? { key: row.key } : {}),
        ...(typeof row.reason === "string" ? { reason: row.reason } : {})
      })
      nodes.set(node.label, node)
      events.push({ type: "node", node, at })
    }
    return events
  }
  const parseLine = (line: string, at: number): Array<TargetRunEvent> => {
    const fromJson = parseObject(line, at)
    if (fromJson.length > 0) return fromJson
    const summary = parseSummary(line, at)
    if (summary !== undefined) return [summary]
    const match = /^(\/\/\S+)\s+(pending|running|hit|ran|failed|skipped|refused|cancelled)\b(?:\s+(\d+(?:\.\d+)?)\s*(ms|s))?(?:\s+(.+))?\s*$/.exec(line)
    if (match === null) return []
    const status = match[2] as NodeTiming["status"]
    const ms = durationMs(match[3], match[4])
    const detail = match[5]?.trim()
    const key = /(?:^|\s)key[=:]\s*([^\s]+)/i.exec(detail ?? "")?.[1]
    const reason = (status === "failed" || status === "refused" || status === "skipped") && detail !== undefined ? detail : undefined
    const node = timing({ label: match[1]!, status, at, ...(ms === undefined ? {} : { durationMs: ms }), ...(key === undefined ? {} : { key }), ...(reason === undefined ? {} : { reason }) })
    nodes.set(node.label, node)
    return [{ type: "node", node, at }]
  }
  const push: RunStdoutParser["push"] = (type, data, at = Date.now()) => {
    buffers[type] += data
    const lines = buffers[type].split(/\r?\n/)
    buffers[type] = lines.pop() ?? ""
    return lines.flatMap((line) => parseLine(line, at))
  }
  return {
    push,
    finish: (at = Date.now()) => {
      const lines = [buffers.stdout, buffers.stderr].filter(Boolean)
      buffers.stdout = ""
      buffers.stderr = ""
      return lines.flatMap((line) => parseLine(line, at))
    },
    timings: () => [...nodes.values()],
    summary: () => lastSummary
  }
}

/** `node <cli> '<label>'` per run, streamed to the run's topic. */
export const createTargetRunner = (options: TargetRunnerOptions): TargetRunner => {
  const cli = options.cli ?? resolveBuildCli()
  const log = options.log ?? (() => {})
  interface Live {
    readonly run: TargetRun
    readonly node: NodeSidecar
    child: ReturnType<typeof Bun.spawn> | undefined
    timer: ReturnType<typeof setTimeout> | undefined
    readonly edges: ReadonlyArray<GraphEdge>
    readonly parser: RunStdoutParser
    summaryEmitted: boolean
    nextSeq: number
  }
  const runs = new Map<string, Live>()
  const maxActiveRuns = options.maxActiveRuns ?? 4
  const maxRetainedRuns = options.maxRetainedRuns ?? 64

  /*
   * Every frame the backend records is stamped with a run-local monotonic
   * `seq` (smithers-shared/TargetGraph). stdout/stderr/exit/error frames
   * carry no `at` of their own, so `seq` is the ONLY total order replay can
   * use; without it two frames in one millisecond — or any untimed frame —
   * are unordered by construction.
   */
  const emit = (run: TargetRun, frame: TargetRunEvent): void => {
    const live = runs.get(run.runId)
    const sequenced = { ...frame, seq: live?.nextSeq ?? 0 } as TargetRunEvent
    if (live !== undefined) live.nextSeq += 1
    options.publish(runTopic(run.runId), { type: "target-run", runId: run.runId, frame: sequenced })
    options.onEvent?.(run, sequenced)
  }

  const pump = async (stream: ReadableStream<Uint8Array>, live: Live, type: "stdout" | "stderr"): Promise<void> => {
    const decoder = new TextDecoder()
    const reader = stream.getReader()
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      const data = decoder.decode(value, { stream: true })
      if (data !== "") {
        const label = /^(\/\/\S+)/.exec(data)?.[1]
        emit(live.run, { type, data, ...(label === undefined ? {} : { label }) })
        for (const event of live.parser.push(type, data)) {
          if (event.type === "summary") live.summaryEmitted = true
          emit(live.run, event)
        }
      }
    }
    const rest = decoder.decode()
    if (rest !== "") {
      const label = /^(\/\/\S+)/.exec(rest)?.[1]
      emit(live.run, { type, data: rest, ...(label === undefined ? {} : { label }) })
      for (const event of live.parser.push(type, rest)) emit(live.run, event)
    }
  }

  const spawn = (live: Live): void => {
    if (live.run.status !== "pending") return
    if (live.timer !== undefined) clearTimeout(live.timer)
    live.timer = undefined
    live.run.status = "running"
    emit(live.run, { type: "started", runId: live.run.runId, label: live.run.label, labels: [...live.run.labels], at: live.run.startedAt })
    if (!existsSync(cli)) {
      live.run.status = "failed"
      emit(live.run, { type: "error", message: `The smthrs loader is missing at ${cli} (set SMITHERS_BUILD_CLI).` })
      emit(live.run, { type: "exit", code: null })
      return
    }
    let child: ReturnType<typeof Bun.spawn>
    try {
      child = Bun.spawn([live.node.path, cli, live.run.label], {
        cwd: workspaceCwd(live.run.repo, live.run.workspace),
        stdout: "pipe",
        stderr: "pipe",
        stdin: "ignore"
      })
    } catch (error) {
      live.run.status = "failed"
      emit(live.run, { type: "error", message: error instanceof Error ? error.message : String(error) })
      emit(live.run, { type: "exit", code: null })
      return
    }
    live.child = child
    log(`target-run ${live.run.runId}: ${live.run.label} in ${workspaceCwd(live.run.repo, live.run.workspace)} (pid ${child.pid})`)
    void Promise.all([
      pump(child.stdout as ReadableStream<Uint8Array>, live, "stdout"),
      pump(child.stderr as ReadableStream<Uint8Array>, live, "stderr")
    ])
      .catch(() => {})
      .then(() => child.exited)
      .then((code) => {
        for (const event of live.parser.finish()) {
          if (event.type === "summary") live.summaryEmitted = true
          emit(live.run, event)
        }
        if (!live.summaryEmitted) {
          const timings = [...live.parser.timings()]
          const count = (status: NodeTiming["status"]): number => timings.filter((node) => node.status === status).length
          const failed = count("failed") + count("refused")
          const summary: RunSummary = { total: timings.length, hit: count("hit"), ran: count("ran"), failed, skipped: count("skipped"), durationMs: Date.now() - live.run.startedAt, ok: code === 0 && failed === 0, criticalPath: [...criticalPath(timings, live.edges)] }
          emit(live.run, { type: "summary", summary, at: Date.now() })
        }
        live.run.exitCode = code
        live.run.status = code === 0 ? "done" : "failed"
        emit(live.run, { type: "exit", code })
      })
  }

  return {
    start: ({ repoId, repo, workspace, label, node, edges = [] }) => {
      const active = [...runs.values()].filter((live) => live.run.status === "pending" || live.run.status === "running")
      if (active.length >= maxActiveRuns) {
        throw new TargetRunCapacityError(`At most ${maxActiveRuns} target runs may execute at once.`)
      }
      while (runs.size >= maxRetainedRuns) {
        const settled = [...runs].find(([, live]) => live.run.status !== "pending" && live.run.status !== "running")
        if (settled === undefined) {
          throw new TargetRunCapacityError(`At most ${maxRetainedRuns} target runs may be retained.`)
        }
        runs.delete(settled[0])
      }
      const startedAt = Date.now()
      const labels = label.split(/\s+/).filter((part) => part.startsWith("//"))
      const run: TargetRun = { runId: crypto.randomUUID(), repoId, repo, workspace, label, labels, startedAt, status: "pending", exitCode: null }
      const live: Live = { run, node, edges, parser: createRunStdoutParser({ edges, startedAt }), child: undefined, timer: undefined, summaryEmitted: false, nextSeq: 0 }
      runs.set(run.runId, live)
      live.timer = setTimeout(() => spawn(live), options.autoStartMs ?? 1000)
      return run
    },
    attach: (runId) => {
      const live = runs.get(runId)
      if (live === undefined) return false
      spawn(live)
      return true
    },
    cancel: (runId) => {
      const live = runs.get(runId)
      if (live === undefined) return false
      if (live.run.status === "pending") {
        if (live.timer !== undefined) clearTimeout(live.timer)
        live.run.status = "failed"
        emit(live.run, { type: "error", message: "Cancelled before it started." })
        emit(live.run, { type: "exit", code: null })
        return true
      }
      if (live.run.status === "running") {
        live.child?.kill()
        return true
      }
      return false
    },
    get: (runId) => runs.get(runId)?.run,
    stop: () => {
      for (const live of runs.values()) {
        if (live.timer !== undefined) clearTimeout(live.timer)
        if (live.run.status === "running") live.child?.kill()
      }
    }
  }
}
