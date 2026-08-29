/**
 * Scoped supervisor for `S.Shell.Serve` services.
 *
 * A `services` edge means: acquire the Serve target, await bounded readiness,
 * keep probing its health while consumers run, scope it to them, and always
 * release it through the declared stop contract. This module owns that
 * lifecycle. The executor resolves a Serve target's attrs into a
 * {@link ServiceSpec} and calls {@link ServiceSupervisor.acquire} inside the
 * consumer's scope; the consumer's work runs under
 * {@link ServiceHandle.whileHealthy} so a service that dies or stops answering
 * fails the consumer with the tail of the captured server output instead of
 * hanging it.
 *
 * Lifetime is scope-based throughout (repo rule: no threaded `AbortSignal`s).
 * One supervisor is created per CLI command; services are reference-counted by
 * `key` through an `RcMap`, so two consumers of one Serve target share one
 * spawn and the process group is stopped when the last consumer's scope
 * closes — on success, on failure, and on interruption alike. A module-level
 * backstop additionally SIGKILLs any still-registered process group when the
 * host process exits or receives an unhandled SIGINT/SIGTERM, so a service
 * child never outlives the command that started it.
 *
 * @since 0.1.0
 */
import { inheritedEnvironmentNames } from "@smthrs/targets/Exec"
import * as Data from "effect/Data"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as RcMap from "effect/RcMap"
import type * as Scope from "effect/Scope"
import * as NodeChildProcess from "node:child_process"
import * as NodeHttp from "node:http"
import * as NodeHttps from "node:https"
import * as NodeNet from "node:net"
import * as NodePath from "node:path"

/**
 * The readiness probe of a Serve target: an open TCP port on the loopback
 * interface, or an HTTP GET whose response status below 500 means ready.
 * Structurally identical to the decoded `Attr.Readiness` union, so executor
 * code passes Serve attrs through unchanged.
 *
 * @category models
 * @since 0.1.0
 */
export type Readiness =
  | { readonly port: number }
  | { readonly http: string; readonly timeout: string }
  | { readonly exec: ReadonlyArray<string>; readonly timeout: string }

/**
 * The health contract of a Serve target: the readiness probe repeated on an
 * interval while consumers run, with `failures` consecutive misses marking
 * the service unhealthy. Structurally identical to the decoded `Attr.Health`.
 *
 * @category models
 * @since 0.1.0
 */
export interface Health {
  readonly interval: string
  readonly failures?: number | undefined
}

/**
 * The stop contract of a Serve target: the graceful-exit signal and the grace
 * period applied before the process group is killed. Structurally identical
 * to the decoded `Attr.Stop`.
 *
 * @category models
 * @since 0.1.0
 */
export interface Stop {
  readonly signal: string
  readonly grace: string
}

/**
 * One resolved Serve target as the supervisor consumes it.
 *
 * The executor derives this from a Serve target's decoded attrs at the
 * integration seam: `key` is the target's label (the refcount identity — two
 * consumers naming one label share one spawn), `cwd` is the
 * workspace-resolved absolute package directory, `argv` is the resolved
 * executable and arguments, and `readiness`/`health`/`stop` are the Serve
 * probe attrs passed through unchanged.
 *
 * @category models
 * @since 0.1.0
 */
export interface ServiceSpec {
  readonly key: string
  readonly cwd: string
  readonly argv: readonly [string, ...Array<string>]
  /** Redacted argv used for in-process identity comparison when spawn argv contains secrets. */
  readonly canonicalArgv?: readonly [string, ...Array<string>] | undefined
  readonly env?: Readonly<Record<string, string>> | undefined
  readonly readiness?: Readiness | undefined
  readonly health?: Health | undefined
  readonly stop?: Stop | undefined
  /**
   * Best-effort commands run before the process is spawned. A service whose
   * runtime holds a name or a port outside the process tree — a Docker
   * container name survives a hard-killed run — clears its own leftovers here
   * so the previous run's death cannot fail this one.
   */
  readonly prepare?: ReadonlyArray<readonly [string, ...Array<string>]> | undefined
  /** Commands run after readiness and before the service is handed to consumers. */
  readonly init?: ReadonlyArray<readonly [string, ...Array<string>]> | undefined
  /** Best-effort commands run during finalization after the process stop contract. */
  readonly cleanup?: ReadonlyArray<readonly [string, ...Array<string>]> | undefined
}

/**
 * A service acquisition or supervision failure.
 *
 * `outputTail` carries the trailing captured server output so a consumer
 * failed by its service sees what the server last said.
 *
 * @category errors
 * @since 0.1.0
 */
export class ServiceError extends Data.TaggedError("smithers-build/ServiceError")<{
  readonly key: string
  readonly reason:
    | "invalid-spec"
    | "spec-drift"
    | "spawn-failed"
    | "exited"
    | "readiness-timeout"
    | "init-failed"
    | "unhealthy"
  readonly message: string
  readonly outputTail: string
}> {}

/**
 * A live, ready service held by one consumer's scope.
 *
 * @category models
 * @since 0.1.0
 */
export interface ServiceHandle {
  readonly key: string
  /** Process id of the shared service child (its process-group leader). */
  readonly pid: number
  /** Trailing captured stdout+stderr of the service, for diagnostics. */
  readonly outputTail: () => string
  /**
   * Runs a consumer effect raced against the service's health: when the
   * service exits or its health probe misses `failures` times in a row, the
   * consumer is interrupted and the result fails with a `ServiceError`
   * carrying the output tail.
   */
  readonly whileHealthy: <A, E, R>(
    consumer: Effect.Effect<A, E, R>
  ) => Effect.Effect<A, E | ServiceError, R>
}

/**
 * The per-command service supervisor.
 *
 * @category models
 * @since 0.1.0
 */
export interface ServiceSupervisor {
  /**
   * Acquires the service for a spec inside the current scope: spawns it in
   * its own process group on first acquisition (subsequent acquisitions of
   * the same `key` share it), awaits bounded readiness, and registers a
   * release on the scope that applies the stop contract when the last
   * consumer lets go.
   */
  readonly acquire: (spec: ServiceSpec) => Effect.Effect<ServiceHandle, ServiceError, Scope.Scope>
}

/**
 * Overall readiness deadline applied to `{port}` probes, which carry no
 * declared timeout of their own.
 *
 * @category constants
 * @since 0.1.0
 */
export const defaultReadinessTimeoutMs = 60_000

/**
 * Delay between readiness probe attempts.
 *
 * @category constants
 * @since 0.1.0
 */
export const readinessPollMs = 250

/**
 * Consecutive health-probe misses that mark a service unhealthy when the
 * declaration omits `failures`.
 *
 * @category constants
 * @since 0.1.0
 */
export const defaultHealthFailures = 3

/**
 * Graceful-exit signal applied when the declaration omits `stop`.
 *
 * @category constants
 * @since 0.1.0
 */
export const defaultStopSignal: NodeJS.Signals = "SIGTERM"

/**
 * Grace period before SIGKILL when the declaration omits `stop`.
 *
 * @category constants
 * @since 0.1.0
 */
export const defaultStopGraceMs = 5_000

/**
 * Maximum length of the captured output tail, in UTF-16 code units.
 *
 * @category constants
 * @since 0.1.0
 */
export const outputTailLimit = 8 * 1024

/** Per-attempt timeout of one TCP connect readiness probe. */
const portProbeAttemptMs = 1_000

/** Upper bound on one health-probe attempt regardless of interval. */
const probeAttemptCapMs = 10_000

/** Bound on waiting for a signalled child to actually report closed. */
const stopSettleMs = 5_000

const durationPattern = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/

/**
 * Parses a Serve duration attr such as `"500ms"`, `"15s"`, `"2m"`, or `"1h"`
 * into milliseconds. This module owns the parser because `Attr.ts` validates
 * these values only as non-empty strings; any other format is refused loudly.
 *
 * @category parsing
 * @since 0.1.0
 */
export const parseDurationMs = (text: string, what: string): number => {
  const match = durationPattern.exec(text.trim())
  if (match === null) {
    throw new Error(
      `${what} is not a duration: ${JSON.stringify(text)} (expected a value like "500ms", "15s", "2m", or "1h")`
    )
  }
  const factor = match[2] === "ms" ? 1 : match[2] === "s" ? 1_000 : match[2] === "m" ? 60_000 : 3_600_000
  const ms = Math.round(Number(match[1]) * factor)
  if (!Number.isSafeInteger(ms) || ms <= 0) {
    throw new Error(`${what} must be a positive duration: ${JSON.stringify(text)}`)
  }
  return ms
}

const signalPattern = /^SIG[A-Z0-9]{1,14}$/

/** The spec with every duration parsed and every default applied. */
interface ParsedSpec {
  readonly spec: ServiceSpec
  readonly readinessTimeoutMs: number
  readonly healthIntervalMs: number | undefined
  readonly healthFailures: number
  readonly stopSignal: NodeJS.Signals
  readonly stopGraceMs: number
  /** Canonical rendering of the spec, for same-key drift detection. */
  readonly canonical: string
}

const canonicalize = (spec: ServiceSpec): string =>
  JSON.stringify({
    argv: spec.canonicalArgv ?? spec.argv,
    cwd: spec.cwd,
    env: Object.fromEntries(Object.entries(spec.env ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
    health: spec.health === undefined
      ? null
      : { failures: spec.health.failures ?? null, interval: spec.health.interval },
    readiness: spec.readiness === undefined
      ? null
      : "port" in spec.readiness
      ? { port: spec.readiness.port }
      : "http" in spec.readiness
      ? { http: spec.readiness.http, timeout: spec.readiness.timeout }
      : { exec: spec.readiness.exec, timeout: spec.readiness.timeout },
    prepare: spec.prepare ?? [],
    init: spec.init ?? [],
    cleanup: spec.cleanup ?? [],
    stop: spec.stop === undefined ? null : { grace: spec.stop.grace, signal: spec.stop.signal }
  })

/** Validates one spec and parses its durations, or throws the exact reason. */
const parseSpec = (spec: ServiceSpec): ParsedSpec => {
  if (typeof spec.key !== "string" || spec.key === "") {
    throw new Error("a service spec requires a non-empty key")
  }
  if (!Array.isArray(spec.argv) || spec.argv.length === 0 || spec.argv.some((entry) => typeof entry !== "string")) {
    throw new Error(`service ${spec.key} requires a non-empty argv of strings`)
  }
  if (spec.argv[0] === "") throw new Error(`service ${spec.key} argv[0] must name an executable`)
  if (
    spec.canonicalArgv !== undefined &&
    (!Array.isArray(spec.canonicalArgv) || spec.canonicalArgv.length !== spec.argv.length ||
      spec.canonicalArgv.some((entry) => typeof entry !== "string"))
  ) {
    throw new Error(`service ${spec.key} canonicalArgv must be a same-length argv of strings`)
  }
  if (typeof spec.cwd !== "string" || !NodePath.isAbsolute(spec.cwd)) {
    throw new Error(`service ${spec.key} requires an absolute cwd; received ${JSON.stringify(spec.cwd)}`)
  }
  let readinessTimeoutMs = defaultReadinessTimeoutMs
  if (spec.readiness !== undefined && !("port" in spec.readiness)) {
    readinessTimeoutMs = parseDurationMs(spec.readiness.timeout, `service ${spec.key} readiness.timeout`)
    if ("http" in spec.readiness) {
      let parsed: URL
      try {
        parsed = new URL(spec.readiness.http)
      } catch {
        throw new Error(`service ${spec.key} readiness.http is not a URL: ${JSON.stringify(spec.readiness.http)}`)
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error(
          `service ${spec.key} readiness.http must be an http(s) URL: ${JSON.stringify(spec.readiness.http)}`
        )
      }
    } else if (
      !Array.isArray(spec.readiness.exec) || spec.readiness.exec.length === 0 ||
      spec.readiness.exec.some((entry) => typeof entry !== "string" || entry === "")
    ) {
      throw new Error(`service ${spec.key} readiness.exec must be a non-empty argv of strings`)
    }
  }
  if (
    spec.readiness !== undefined && "port" in spec.readiness &&
    (!Number.isSafeInteger(spec.readiness.port) || spec.readiness.port < 1 || spec.readiness.port > 65_535)
  ) {
    throw new Error(`service ${spec.key} readiness.port is not a port: ${JSON.stringify(spec.readiness.port)}`)
  }
  let healthIntervalMs: number | undefined
  let healthFailures = defaultHealthFailures
  if (spec.health !== undefined) {
    if (spec.readiness === undefined) {
      throw new Error(
        `service ${spec.key} declares health but no readiness; health repeats the readiness probe, so declare one`
      )
    }
    healthIntervalMs = parseDurationMs(spec.health.interval, `service ${spec.key} health.interval`)
    if (spec.health.failures !== undefined) {
      if (!Number.isSafeInteger(spec.health.failures) || spec.health.failures < 1) {
        throw new Error(`service ${spec.key} health.failures must be a positive integer`)
      }
      healthFailures = spec.health.failures
    }
  }
  let stopSignal: NodeJS.Signals = defaultStopSignal
  let stopGraceMs = defaultStopGraceMs
  if (spec.stop !== undefined) {
    if (!signalPattern.test(spec.stop.signal)) {
      throw new Error(`service ${spec.key} stop.signal is not a signal name: ${JSON.stringify(spec.stop.signal)}`)
    }
    stopSignal = spec.stop.signal as NodeJS.Signals
    stopGraceMs = parseDurationMs(spec.stop.grace, `service ${spec.key} stop.grace`)
  }
  for (const [name, commands] of [["prepare", spec.prepare], ["init", spec.init], ["cleanup", spec.cleanup]] as const) {
    if (commands !== undefined) {
      if (
        !Array.isArray(commands) ||
        commands.some((argv) =>
          !Array.isArray(argv) || argv.length === 0 || argv.some((entry) => typeof entry !== "string" || entry === "")
        )
      ) {
        throw new Error(`service ${spec.key} ${name} must be an array of non-empty argv arrays`)
      }
    }
  }
  return {
    spec,
    readinessTimeoutMs,
    healthIntervalMs,
    healthFailures,
    stopSignal,
    stopGraceMs,
    canonical: canonicalize(spec)
  }
}

// ---------------------------------------------------------------------------
// Orphan backstop
//
// Scope finalizers are the release path, but a process that dies without
// running them — an unhandled SIGINT, an explicit process.exit — would leak
// detached service children, which survive their parent. A module-level
// registry of live process groups backs the finalizers: on 'exit' every
// remaining group is SIGKILLed synchronously, and a SIGINT/SIGTERM with no
// other listener kills the groups and re-raises so the default termination
// still happens. When the embedding program handles the signal itself (the
// integrator interrupting the main fiber for a graceful stop), the backstop
// only schedules a delayed sweep that is a no-op once finalizers deregister
// the groups.
// ---------------------------------------------------------------------------

const liveGroups = new Set<number>()
let backstopInstalled = false

const killAllGroups = (): void => {
  for (const pid of [...liveGroups]) {
    try {
      process.kill(-pid, "SIGKILL")
    } catch {
      // The group may already be gone, or groups may be unsupported here.
    }
    try {
      process.kill(pid, "SIGKILL")
    } catch {
      // The child itself may already be gone.
    }
  }
  liveGroups.clear()
}

const onProcessExit = (): void => killAllGroups()

const backstopFor = (signal: NodeJS.Signals): () => void => {
  const handler = (): void => {
    if (process.listenerCount(signal) === 1) {
      // Nothing else owns this signal: hard-stop the services and re-raise so
      // the process still dies of it.
      killAllGroups()
      process.removeListener(signal, handler)
      process.kill(process.pid, signal)
      return
    }
    // The embedding program handles the signal; give its finalizers a moment
    // to release gracefully, then sweep whatever is left.
    const timer = setTimeout(killAllGroups, 5_000)
    timer.unref()
  }
  return handler
}

const onSigint = backstopFor("SIGINT")
const onSigterm = backstopFor("SIGTERM")

const registerGroup = (pid: number): void => {
  liveGroups.add(pid)
  if (backstopInstalled) return
  backstopInstalled = true
  process.on("exit", onProcessExit)
  process.on("SIGINT", onSigint)
  process.on("SIGTERM", onSigterm)
}

const deregisterGroup = (pid: number): void => {
  liveGroups.delete(pid)
  if (liveGroups.size > 0 || !backstopInstalled) return
  backstopInstalled = false
  process.removeListener("exit", onProcessExit)
  process.removeListener("SIGINT", onSigint)
  process.removeListener("SIGTERM", onSigterm)
}

// ---------------------------------------------------------------------------
// Output capture
// ---------------------------------------------------------------------------

/** Whether slicing `text` at `index` would split a surrogate pair. */
const splitsPair = (text: string, index: number): boolean => {
  if (index <= 0 || index >= text.length) return false
  const high = text.charCodeAt(index - 1)
  const low = text.charCodeAt(index)
  return high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff
}

/** Keeps the trailing `limit` code units without splitting a surrogate pair. */
const keepTail = (text: string, limit: number): string => {
  if (text.length <= limit) return text
  const at = text.length - limit
  return text.slice(splitsPair(text, at) ? at + 1 : at)
}

/** Bounded, chronological tail of the service's combined output streams. */
interface TailCapture {
  readonly append: (chunk: Uint8Array, decoder: TextDecoder) => void
  readonly read: () => string
}

const tailCapture = (): TailCapture => {
  let text = ""
  return {
    append: (chunk, decoder) => {
      text = keepTail(text + decoder.decode(chunk, { stream: true }), outputTailLimit)
    },
    read: () => text
  }
}

// ---------------------------------------------------------------------------
// Probes
// ---------------------------------------------------------------------------

type Probe = { readonly ok: true } | { readonly ok: false; readonly reason: string }

const miss = (reason: string): Probe => ({ ok: false, reason })

/** Runs one readiness probe attempt; never fails, reports the miss reason. */
const probeOnce = (readiness: Readiness, attemptTimeoutMs: number): Effect.Effect<Probe> =>
  Effect.callback<Probe>((resume) => {
    let settled = false
    let cleanup: () => void = () => {}
    const settle = (result: Probe): void => {
      if (settled) return
      settled = true
      cleanup()
      resume(Effect.succeed(result))
    }
    const timer = setTimeout(
      () => settle(miss(`the probe timed out after ${attemptTimeoutMs}ms`)),
      Math.max(attemptTimeoutMs, 1)
    )
    if ("port" in readiness) {
      const socket = NodeNet.connect({ host: "127.0.0.1", port: readiness.port })
      cleanup = () => {
        clearTimeout(timer)
        socket.destroy()
      }
      socket.on("connect", () => settle({ ok: true }))
      socket.on("error", (error: NodeJS.ErrnoException) => settle(miss(`connect failed: ${error.message}`)))
    } else if ("http" in readiness) {
      const url = new URL(readiness.http)
      const get = url.protocol === "https:" ? NodeHttps.get : NodeHttp.get
      const request = get(url, (response) => {
        response.resume()
        const status = response.statusCode ?? 0
        settle(status > 0 && status < 500 ? { ok: true } : miss(`GET ${readiness.http} answered ${status}`))
      })
      cleanup = () => {
        clearTimeout(timer)
        request.destroy()
      }
      request.on(
        "error",
        (error: NodeJS.ErrnoException) => settle(miss(`GET ${readiness.http} failed: ${error.message}`))
      )
    } else {
      const child = NodeChildProcess.execFile(
        readiness.exec[0]!,
        readiness.exec.slice(1),
        { env: serviceEnvironment(undefined), timeout: Math.max(attemptTimeoutMs, 1), maxBuffer: 1 << 20 },
        (error, stdout, stderr) => {
          settle(
            error === null
              ? { ok: true }
              : miss(`exec failed: ${`${stdout}${stderr}`.trim() || error.message}`)
          )
        }
      )
      cleanup = () => {
        clearTimeout(timer)
        child.kill("SIGKILL")
      }
    }
    return Effect.sync(() => {
      settled = true
      cleanup()
    })
  })

// ---------------------------------------------------------------------------
// Service lifecycle
// ---------------------------------------------------------------------------

/** One running, supervised service shared by every consumer of its key. */
interface RunningService {
  readonly key: string
  readonly pid: number
  readonly unhealthy: Deferred.Deferred<never, ServiceError>
  readonly tail: () => string
}

/** Mutable lifecycle flags shared between listeners and the finalizer. */
interface ServiceState {
  stopping: boolean
  exited: boolean
}

/**
 * Minimal child environment: the documented host bootstrap names plus the
 * spec's declared variables, mirroring the exec boundary rather than the
 * whole ambient `process.env`.
 */
const serviceEnvironment = (declared: Readonly<Record<string, string>> | undefined): NodeJS.ProcessEnv => {
  const env = Object.create(null) as NodeJS.ProcessEnv
  for (const name of inheritedEnvironmentNames) {
    const value = process.env[name]
    if (value !== undefined) env[name] = value
  }
  for (const [name, value] of Object.entries(declared ?? {})) env[name] = value
  return env
}

/** Signals a child's process group, falling back to the child itself. */
const signalGroup = (child: NodeChildProcess.ChildProcess, signal: NodeJS.Signals): void => {
  if (child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal)
      return
    } catch {
      // Fall through when process groups are unavailable.
    }
  }
  try {
    child.kill(signal)
  } catch {
    // The process may have settled already.
  }
}

/**
 * Applies the stop contract: the declared signal to the group, the grace
 * period, then SIGKILL, bounded so release can never hang.
 */
const stopService = (
  child: NodeChildProcess.ChildProcess,
  parsed: ParsedSpec,
  state: ServiceState,
  exited: Promise<void>
): Effect.Effect<void> =>
  Effect.callback<void>((resume) => {
    state.stopping = true
    let settled = false
    const timers: Array<NodeJS.Timeout> = []
    const finish = (): void => {
      if (settled) return
      settled = true
      for (const timer of timers) clearTimeout(timer)
      if (child.pid !== undefined) deregisterGroup(child.pid)
      resume(Effect.void)
    }
    if (state.exited) {
      finish()
      return Effect.void
    }
    signalGroup(child, parsed.stopSignal)
    timers.push(setTimeout(() => signalGroup(child, "SIGKILL"), parsed.stopGraceMs))
    timers.push(setTimeout(finish, parsed.stopGraceMs + stopSettleMs))
    exited.then(finish, finish)
    return Effect.sync(finish)
  })

/** Polls the readiness probe until it passes or the deadline expires. */
const awaitReadiness = (
  parsed: ParsedSpec,
  readiness: Readiness,
  tail: () => string
): Effect.Effect<void, ServiceError> =>
  Effect.gen(function*() {
    const attemptMs = "port" in readiness
      ? portProbeAttemptMs
      : Math.min(parsed.readinessTimeoutMs, probeAttemptCapMs)
    const deadline = Date.now() + parsed.readinessTimeoutMs
    let lastMiss = "the probe never ran"
    while (Date.now() < deadline) {
      const remaining = deadline - Date.now()
      const result = yield* probeOnce(readiness, Math.min(attemptMs, remaining))
      if (result.ok) return
      lastMiss = result.reason
      yield* Effect.sleep(Math.min(readinessPollMs, Math.max(deadline - Date.now(), 0)))
    }
    return yield* Effect.fail(
      new ServiceError({
        key: parsed.spec.key,
        reason: "readiness-timeout",
        message: `service ${parsed.spec.key} was not ready within ${parsed.readinessTimeoutMs}ms: ${lastMiss}`,
        outputTail: tail()
      })
    )
  })

/** Re-runs the readiness probe on the declared interval until unhealthy. */
const healthLoop = (
  parsed: ParsedSpec,
  readiness: Readiness,
  intervalMs: number,
  state: ServiceState,
  unhealthy: Deferred.Deferred<never, ServiceError>,
  tail: () => string
): Effect.Effect<void> => {
  const attemptMs = Math.min(intervalMs, probeAttemptCapMs)
  const step = (misses: number): Effect.Effect<void> =>
    Effect.gen(function*() {
      yield* Effect.sleep(intervalMs)
      if (state.stopping || Deferred.isDoneUnsafe(unhealthy)) return
      const result = yield* probeOnce(readiness, attemptMs)
      if (state.stopping || Deferred.isDoneUnsafe(unhealthy)) return
      if (result.ok) return yield* step(0)
      const next = misses + 1
      if (next >= parsed.healthFailures) {
        Deferred.doneUnsafe(
          unhealthy,
          Effect.fail(
            new ServiceError({
              key: parsed.spec.key,
              reason: "unhealthy",
              message: `service ${parsed.spec.key} failed ${next} consecutive health probes: ${result.reason}`,
              outputTail: tail()
            })
          )
        )
        return
      }
      return yield* step(next)
    })
  return step(0)
}

/** Runs service init commands sequentially after readiness. */
const runInit = (parsed: ParsedSpec, tail: () => string): Effect.Effect<void, ServiceError> =>
  Effect.gen(function*() {
    for (const argv of parsed.spec.init ?? []) {
      const result = yield* Effect.callback<{ readonly ok: boolean; readonly detail: string }>((resume) => {
        const child = NodeChildProcess.execFile(
          argv[0],
          argv.slice(1),
          {
            cwd: parsed.spec.cwd,
            env: serviceEnvironment(parsed.spec.env),
            timeout: parsed.readinessTimeoutMs,
            maxBuffer: 1 << 20
          },
          (error, stdout, stderr) =>
            resume(Effect.succeed({
              ok: error === null,
              detail: `${stdout}${stderr}`.trim() || (error === null ? "" : error.message)
            }))
        )
        return Effect.sync(() => child.kill("SIGKILL"))
      })
      if (!result.ok) {
        return yield* Effect.fail(
          new ServiceError({
            key: parsed.spec.key,
            reason: "init-failed",
            message: `service ${parsed.spec.key} init command failed: ${argv.join(" ")}${
              result.detail === "" ? "" : `: ${result.detail}`
            }`,
            outputTail: tail()
          })
        )
      }
    }
    return yield* Effect.void
  })

/** Runs one list of best-effort commands to completion, ignoring their exit status. */
const runBestEffort = (
  parsed: ParsedSpec,
  commands: ReadonlyArray<readonly [string, ...Array<string>]> | undefined
): Effect.Effect<void> =>
  Effect.gen(function*() {
    for (const argv of commands ?? []) {
      yield* Effect.callback<void>((resume) => {
        const child = NodeChildProcess.execFile(
          argv[0],
          argv.slice(1),
          {
            cwd: parsed.spec.cwd,
            env: serviceEnvironment(parsed.spec.env),
            timeout: parsed.stopGraceMs + stopSettleMs
          },
          () => resume(Effect.void)
        )
        return Effect.sync(() => child.kill("SIGKILL"))
      })
    }
  }).pipe(Effect.asVoid)

/** Runs best-effort prepare commands before the service process is spawned. */
const runPrepare = (parsed: ParsedSpec): Effect.Effect<void> => runBestEffort(parsed, parsed.spec.prepare)

/** Runs best-effort cleanup commands during scope finalization. */
const runCleanup = (parsed: ParsedSpec): Effect.Effect<void> => runBestEffort(parsed, parsed.spec.cleanup)

/**
 * Spawns one service in its own process group, awaits readiness, and starts
 * the health loop, all inside the scope the `RcMap` provides for its key.
 */
const startService = (parsed: ParsedSpec): Effect.Effect<RunningService, ServiceError, Scope.Scope> =>
  Effect.gen(function*() {
    const key = parsed.spec.key
    const unhealthy = yield* Deferred.make<never, ServiceError>()
    const state: ServiceState = { stopping: false, exited: false }
    const tail = tailCapture()
    const stdoutDecoder = new TextDecoder("utf-8")
    const stderrDecoder = new TextDecoder("utf-8")
    const failWith = (reason: "spawn-failed" | "exited", message: string): void => {
      Deferred.doneUnsafe(
        unhealthy,
        Effect.fail(new ServiceError({ key, reason, message, outputTail: tail.read() }))
      )
    }
    yield* runPrepare(parsed)
    const child = yield* Effect.try({
      try: () =>
        NodeChildProcess.spawn(parsed.spec.argv[0], parsed.spec.argv.slice(1), {
          cwd: parsed.spec.cwd,
          detached: true,
          env: serviceEnvironment(parsed.spec.env),
          stdio: ["ignore", "pipe", "pipe"]
        }),
      catch: (cause) =>
        new ServiceError({
          key,
          reason: "spawn-failed",
          message: `service ${key} could not be spawned: ${cause instanceof Error ? cause.message : String(cause)}`,
          outputTail: ""
        })
    })
    let resolveExited: () => void = () => {}
    const exited = new Promise<void>((resolve) => {
      resolveExited = resolve
    })
    child.stdout?.on("data", (chunk: Buffer) => tail.append(chunk, stdoutDecoder))
    child.stderr?.on("data", (chunk: Buffer) => tail.append(chunk, stderrDecoder))
    child.on("error", (error: NodeJS.ErrnoException) => {
      state.exited = true
      resolveExited()
      failWith("spawn-failed", `service ${key} could not be spawned: ${error.message}`)
    })
    child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
      state.exited = true
      resolveExited()
      if (state.stopping) return
      failWith(
        "exited",
        `service ${key} exited ${signal === null ? `with code ${code}` : `on ${signal}`} while supervised`
      )
    })
    if (child.pid !== undefined) registerGroup(child.pid)
    // The finalizer is registered before readiness so a failed or interrupted
    // acquisition still stops the child through the declared stop contract.
    yield* Effect.addFinalizer(() => stopService(child, parsed, state, exited).pipe(Effect.andThen(runCleanup(parsed))))
    if (parsed.spec.readiness !== undefined) {
      yield* Effect.raceFirst(
        awaitReadiness(parsed, parsed.spec.readiness, tail.read),
        Deferred.await(unhealthy)
      )
    } else {
      // No probe: liveness is process liveness. A brief settle window lets an
      // immediate spawn failure (a missing executable) surface as the typed
      // error instead of a ready handle.
      yield* Effect.raceFirst(Effect.sleep(50), Deferred.await(unhealthy))
    }
    yield* runInit(parsed, tail.read)
    if (parsed.healthIntervalMs !== undefined && parsed.spec.readiness !== undefined) {
      yield* Effect.forkScoped(
        healthLoop(parsed, parsed.spec.readiness, parsed.healthIntervalMs, state, unhealthy, tail.read)
      )
    }
    return { key, pid: child.pid ?? -1, unhealthy, tail: tail.read }
  })

/**
 * Creates a per-command supervisor whose services live at most as long as
 * the provided scope. Consumers acquire services in their own scopes; a
 * service is spawned on its first acquisition, shared by refcount while any
 * consumer holds it, and released through its stop contract when the last
 * consumer scope closes.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make: Effect.Effect<ServiceSupervisor, never, Scope.Scope> = Effect.gen(function*() {
  const specs = new Map<string, ParsedSpec>()
  const services = yield* RcMap.make({
    lookup: (key: string): Effect.Effect<RunningService, ServiceError, Scope.Scope> => {
      const parsed = specs.get(key)
      return parsed === undefined
        ? Effect.die(new Error(`service ${key} was looked up before its spec was registered`))
        : startService(parsed)
    }
  })
  const acquire = (spec: ServiceSpec): Effect.Effect<ServiceHandle, ServiceError, Scope.Scope> =>
    Effect.gen(function*() {
      const parsed = yield* Effect.try({
        try: () => parseSpec(spec),
        catch: (cause) =>
          new ServiceError({
            key: typeof spec.key === "string" && spec.key !== "" ? spec.key : "<invalid key>",
            reason: "invalid-spec",
            message: cause instanceof Error ? cause.message : String(cause),
            outputTail: ""
          })
      })
      // Registration and the drift check are one synchronous step, so two
      // concurrent acquires cannot interleave between check and set.
      yield* Effect.suspend(() => {
        const existing = specs.get(spec.key)
        if (existing === undefined) {
          specs.set(spec.key, parsed)
          return Effect.void
        }
        return existing.canonical === parsed.canonical
          ? Effect.void
          : Effect.fail(
            new ServiceError({
              key: spec.key,
              reason: "spec-drift",
              message: `service ${spec.key} was acquired twice with different specs; ` +
                `one key must resolve to one command per supervisor`,
              outputTail: ""
            })
          )
      })
      const service = yield* RcMap.get(services, spec.key)
      // A service that already went unhealthy fails new consumers immediately
      // rather than handing out a dead handle.
      if (Deferred.isDoneUnsafe(service.unhealthy)) {
        yield* Deferred.await(service.unhealthy)
      }
      return {
        key: service.key,
        pid: service.pid,
        outputTail: service.tail,
        whileHealthy: <A, E, R>(consumer: Effect.Effect<A, E, R>): Effect.Effect<A, E | ServiceError, R> =>
          Effect.raceFirst(consumer, Deferred.await(service.unhealthy))
      }
    })
  return { acquire }
})
