/**
 * `smithers up -d`: launch a run in a process that outlives this one.
 *
 * The 0.x launcher's hard-won rule is carried over unchanged: a detached
 * launch returns only after the child has *proved* it persisted the run row,
 * never on spawn success. A launcher that returns on spawn reports a run id
 * for a process that may already have died on a missing credential, and the
 * operator finds out minutes later from an empty `ps`.
 *
 * The proof is one line the child writes to its own log the moment the control
 * plane hands back an `Accepted` receipt (see {@link admissionLine}). The
 * parent polls the log for it, and only then renames the log onto the run id
 * and prints the receipt. A child that exits before writing the line, or that
 * is still silent at the deadline, is reported as a failed launch with the
 * log's tail attached.
 *
 * @since 1.0.0
 */
import { spawn } from "node:child_process"
import type { ChildProcess } from "node:child_process"
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readSync, renameSync, unlinkSync } from "node:fs"
import { join } from "node:path"
import * as Project from "./Project.ts"

/**
 * The environment name that tells a `smithers run` child it was launched
 * detached, and which nonce to stamp its admission line with.
 *
 * Internal parent-to-child handoff: never set it by hand.
 *
 * @category constants
 * @since 1.0.0
 */
export const admissionVariable = "SMITHERS_INTERNAL_DETACHED_ADMISSION"

/**
 * How long a launch waits for the admission line before giving up, and the
 * multiple of that window a *live* child is granted on top.
 *
 * A child that is still alive at the deadline is booting slowly, not stuck:
 * module-graph parse alone can exceed the window on a loaded machine. Only a
 * child that is both silent and alive past the grace window is terminated.
 *
 * @category constants
 * @since 1.0.0
 */
export const defaultTimeoutMs = 30_000

/**
 * Grace given to each of SIGTERM and SIGKILL during failed-launch cleanup.
 *
 * @category constants
 * @since 1.0.0
 */
export const defaultTerminationGraceMs = 2_000

/** The extra multiple of the timeout a still-running child is granted. */
const liveChildGraceMultiple = 4

/** How much of the log tail is reported with a failed launch. */
const tailBytes = 32 * 1024

/** How often the parent re-reads the log while waiting. */
const pollIntervalMs = 50

/**
 * The line a detached child writes once its run row is durable.
 *
 * @category constructors
 * @since 1.0.0
 */
export const admissionLine = (nonce: string, runId: string): string =>
  `SMITHERS_DETACHED_ADMISSION=run:${nonce} runId=${runId}`

/**
 * Reads the run id out of a log tail that contains this nonce's admission
 * line, or `undefined` when it does not.
 *
 * @category getters
 * @since 1.0.0
 */
export const admittedRunId = (tail: string, nonce: string): string | undefined => {
  const marker = `SMITHERS_DETACHED_ADMISSION=run:${nonce} runId=`
  const start = tail.indexOf(marker)
  if (start < 0) return undefined
  const rest = tail.slice(start + marker.length)
  const end = rest.search(/\s/)
  const runId = end < 0 ? rest : rest.slice(0, end)
  return runId === "" ? undefined : runId
}

/**
 * Reads the last bytes of a log file, or `""` when there is nothing to read.
 *
 * @category getters
 * @since 1.0.0
 */
export const logTail = (file: string, maxBytes: number = tailBytes): string => {
  if (!existsSync(file)) return ""
  let descriptor: number | undefined
  try {
    descriptor = openSync(file, "r")
    const size = fstatSync(descriptor).size
    const length = Math.min(size, Math.max(1, maxBytes))
    const buffer = Buffer.alloc(length)
    readSync(descriptor, buffer, 0, length, Math.max(0, size - length))
    return buffer.toString("utf8")
  } catch {
    return ""
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
  }
}

/** Whether a POSIX process group still has a member. */
const processGroupAlive = (pid: number): boolean => {
  try {
    process.kill(-pid, 0)
    return true
  } catch (error) {
    return (error as { readonly code?: string } | null)?.code !== "ESRCH"
  }
}

const childAlive = (child: ChildProcess): boolean => child.exitCode === null && child.signalCode === null

const waitUntil = async (predicate: () => boolean, timeoutMs: number): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs
  while (predicate()) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) return false
    await sleep(Math.min(pollIntervalMs, remaining))
  }
  return true
}

const signalGroup = (pid: number, signal: NodeJS.Signals): void => {
  try {
    process.kill(-pid, signal)
  } catch (error) {
    if ((error as { readonly code?: string } | null)?.code !== "ESRCH") throw error
  }
}

/**
 * Terminates and reaps a child that never reached admission.
 *
 * On POSIX the group, not just its leader, must disappear before this resolves.
 * A cooperative group gets SIGTERM; a group still present after the grace
 * window gets SIGKILL and another bounded reap window. The boolean is false
 * when the host could not confirm containment, so a caller never reports an
 * orphan-prone launch as successfully terminated.
 *
 * @category destructors
 * @since 1.0.0
 */
export const terminate = async (
  child: ChildProcess,
  graceMs: number = defaultTerminationGraceMs
): Promise<boolean> => {
  const grace = Number.isFinite(graceMs) ? Math.max(1, Math.trunc(graceMs)) : defaultTerminationGraceMs
  const pid = child.pid
  if (pid !== undefined && process.platform !== "win32") {
    if (!processGroupAlive(pid)) return true
    try {
      signalGroup(pid, "SIGTERM")
    } catch {
      return false
    }
    if (await waitUntil(() => processGroupAlive(pid), grace)) return true
    try {
      signalGroup(pid, "SIGKILL")
    } catch {
      return false
    }
    return waitUntil(() => processGroupAlive(pid), grace)
  }

  if (!childAlive(child)) return true
  try {
    child.kill("SIGTERM")
  } catch {
    return !childAlive(child)
  }
  if (await waitUntil(() => childAlive(child), grace)) return true
  try {
    child.kill("SIGKILL")
  } catch {
    return !childAlive(child)
  }
  return waitUntil(() => childAlive(child), grace)
}

/**
 * A successful detached launch.
 *
 * @category models
 * @since 1.0.0
 */
export interface Launched {
  readonly runId: string
  readonly logFile: string
  readonly pid: number | undefined
}

/**
 * A launch that never reached admission.
 *
 * @category models
 * @since 1.0.0
 */
export interface Rejected {
  readonly reason: string
  readonly tail: string
  readonly logFile: string
}

/**
 * Arguments accepted by {@link launch}.
 *
 * @category models
 * @since 1.0.0
 */
export interface Options {
  /** The project root; the log lands under its `.flows/logs`. */
  readonly root: string
  /** The serialized plan approval payload the child runs. */
  readonly payload: string
  /** Extra arguments handed to the child, such as `--remote`. */
  readonly passthrough?: ReadonlyArray<string> | undefined
  readonly timeoutMs?: number | undefined
  readonly environment?: Readonly<Record<string, string | undefined>> | undefined
  /** The Node executable and CLI entry the child re-executes. */
  readonly execPath?: string | undefined
  readonly entry?: string | undefined
  readonly intervalMs?: number | undefined
  /** Grace given to each cleanup signal after the admission deadline. */
  readonly terminationGraceMs?: number | undefined
  /** Where a slow-boot notice goes; stderr in production. */
  readonly onSlowBoot?: ((message: string) => void) | undefined
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Launches an approved plan in a detached process and waits for its admission
 * line.
 *
 * @category constructors
 * @since 1.0.0
 */
export const launch = async (options: Options): Promise<Launched | Rejected> => {
  const timeoutMs = Math.max(1, options.timeoutMs ?? defaultTimeoutMs)
  const maxWaitMs = timeoutMs * liveChildGraceMultiple
  const intervalMs = Math.max(1, options.intervalMs ?? pollIntervalMs)
  const nonce = `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const directory = Project.logDirectory(options.root)
  mkdirSync(directory, { recursive: true })
  // The run id does not exist until the child is admitted, so the log opens
  // under the nonce and is renamed onto the run id afterwards. On POSIX the
  // child keeps writing through its open descriptor across the rename, so no
  // output is lost and no second file appears.
  const pending = join(directory, `pending-${nonce}.log`)
  const descriptor = openSync(pending, "a")

  let child: ChildProcess
  try {
    child = spawn(
      options.execPath ?? process.execPath,
      [options.entry ?? process.argv[1]!, "run", options.payload, ...(options.passthrough ?? [])],
      {
        cwd: options.root,
        detached: true,
        stdio: ["ignore", descriptor, descriptor],
        env: { ...(options.environment ?? process.env), [admissionVariable]: nonce }
      }
    )
  } finally {
    closeSync(descriptor)
  }
  child.unref()

  const startedAt = Date.now()
  let notified = false
  try {
    for (;;) {
      const tail = logTail(pending)
      const runId = admittedRunId(tail, nonce)
      // The readiness proof wins over a later child exit: once the run row is
      // durable, a child that dies afterwards is the stale-run sweep's
      // problem, not the launcher's.
      if (runId !== undefined) {
        const file = Project.logFile(options.root, runId)
        renameSync(pending, file)
        return { runId, logFile: file, pid: child.pid }
      }
      if (child.exitCode !== null || child.signalCode !== null) {
        const status = child.signalCode === null ? `exit ${child.exitCode}` : `signal ${child.signalCode}`
        return {
          reason: `Detached engine exited before admission (${status}).`,
          tail,
          logFile: pending
        }
      }
      const elapsedMs = Date.now() - startedAt
      if (elapsedMs >= maxWaitMs) {
        const terminated = await terminate(child, options.terminationGraceMs)
        return {
          reason: `Detached engine did not reach admission within ${maxWaitMs}ms. The engine process (pid ${
            child.pid ?? "unknown"
          }) was still alive and ${
            terminated ? "was terminated" : "could not be confirmed terminated"
          }. Set SMITHERS_DETACHED_ADMISSION_TIMEOUT_MS to raise the window.`,
          tail,
          logFile: pending
        }
      }
      if (elapsedMs >= timeoutMs && !notified) {
        notified = true
        const notify = options.onSlowBoot ??
          ((line: string) => {
            process.stderr.write(`${line}\n`)
          })
        notify(
          `smithers: detached engine (pid ${child.pid ?? "unknown"}) is still booting after ${
            Math.round(elapsedMs / 1000)
          }s; waiting up to ${Math.round(maxWaitMs / 1000)}s.`
        )
      }
      await sleep(Math.min(intervalMs, maxWaitMs - elapsedMs))
    }
  } finally {
    child.removeAllListeners()
  }
}

/**
 * Removes a rejected launch's pending log.
 *
 * @category destructors
 * @since 1.0.0
 */
export const discard = (rejected: Rejected): void => {
  try {
    unlinkSync(rejected.logFile)
  } catch {
    // A log that is already gone needs no cleanup.
  }
}

/**
 * Whether a `Launched` was produced, as opposed to a `Rejected`.
 *
 * @category guards
 * @since 1.0.0
 */
export const isLaunched = (result: Launched | Rejected): result is Launched => "runId" in result
