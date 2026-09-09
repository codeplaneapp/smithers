/**
 * Spawning the parking host and its replacement.
 *
 * A `linger` host is built never to exit, so the harness owns every process it
 * spawns rather than trusting each case to reach its kill. A failed assertion
 * between the park and the kill would otherwise leave a host running against a
 * database its case is about to delete. Cases call `reapWaitChildren` before
 * they remove their directory; the fault tier runs one file at a time, so
 * everything still owned at that point belongs to the case that is ending.
 *
 * @since 1.0.0
 */
import { type ChildProcess, spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import type { WaitMode, WaitOptions } from "./waitFlows.ts"

const runner = fileURLToPath(new URL("../fixtures/waitChild.ts", import.meta.url))

/** How long a host may print nothing new before its waits refuse. */
const defaultDeadlineMs = 60_000

/** What the child does with the run it finds. */
export type WaitPhase = "linger" | "settle" | "resolve" | "notify" | "race-timer"

/**
 * A spawned wait host.
 *
 * @since 1.0.0
 * @category models
 */
export interface WaitChild {
  readonly process: ChildProcess
  readonly pid: number
  readonly stdout: () => string
  readonly stderr: () => string
  readonly exited: Promise<number | null>
  /** Resolves once the run has parked and the child printed `PARKED=`. */
  readonly parked: Promise<string>
  /** Resolves once the child printed `SETTLED=`, with the decoded value. */
  readonly settled: Promise<unknown>
}

/** Every host spawned here that has not been reaped yet. */
const owned = new Set<WaitChild>()

/**
 * Spawns one wait host.
 *
 * @since 1.0.0
 * @category constructors
 */
export const spawnWaitChild = (
  options: WaitOptions & {
    readonly executionId: string
    readonly mode: WaitMode
    readonly phase: WaitPhase
    readonly millis?: number | undefined
    readonly deadlineMs?: number | undefined
  }
): WaitChild => {
  const child = spawn(
    process.execPath,
    [
      runner,
      options.filename,
      options.executionId,
      options.mode,
      options.phase,
      options.counterFile,
      options.hostId,
      String(options.millis ?? 3_000)
    ],
    { stdio: ["ignore", "pipe", "pipe"] }
  )
  const pid = child.pid
  if (pid === undefined) throw new Error("wait child has no pid")

  let out = ""
  let err = ""
  child.stdout?.setEncoding("utf8")
  child.stderr?.setEncoding("utf8")

  let announceParked: (id: string) => void = () => {}
  let announceSettled: (value: unknown) => void = () => {}
  let refuse: (cause: unknown) => void = () => {}
  const parked = new Promise<string>((resolve, reject) => {
    announceParked = resolve
    refuse = reject
  })
  const settled = new Promise<unknown>((resolve, reject) => {
    announceSettled = resolve
    const previous = refuse
    refuse = (cause) => {
      previous(cause)
      reject(cause)
    }
  })
  // Both promises are observed by every caller, so an unobserved rejection can
  // never crash the runner even when a case only awaits one of them.
  parked.catch(() => {})
  settled.catch(() => {})

  // A host that never announces readiness must fail its case fast instead of
  // hanging until the tier's own timeout, so each announcement buys the next
  // one a fresh budget.
  const deadlineMs = options.deadlineMs ?? defaultDeadlineMs
  let deadline: ReturnType<typeof setTimeout> | undefined
  const arm = (): void => {
    clearTimeout(deadline)
    deadline = setTimeout(
      () => refuse(new Error(`wait child ${pid} announced nothing within ${deadlineMs}ms\n${out}${err}`)),
      deadlineMs
    )
    // A case's own budget must never be the handle that keeps this process
    // alive after the case is over.
    deadline.unref()
  }
  arm()

  const read = (chunk: string): void => {
    out += chunk
    const park = /PARKED=(.+)\n/.exec(out)
    if (park !== null) announceParked(park[1] as string)
    const settle = /SETTLED=(.*)\n/.exec(out)
    if (settle !== null) announceSettled(JSON.parse(settle[1] as string))
    arm()
  }
  child.stdout?.on("data", read)
  child.stderr?.on("data", (chunk: string) => {
    err += chunk
    arm()
  })

  const exited = new Promise<number | null>((resolve) => {
    child.once("exit", (code) => {
      clearTimeout(deadline)
      refuse(new Error(`wait child exited with ${String(code)}\n${err}`))
      resolve(code)
    })
  })

  const host: WaitChild = { process: child, pid, stdout: () => out, stderr: () => err, exited, parked, settled }
  owned.add(host)
  return host
}

/**
 * Force-kills and reaps every host this harness spawned.
 *
 * Reaping is unconditional and never throws: it is teardown, and the case it
 * runs for may already have killed some of its hosts or failed before killing
 * any of them. Waiting on each exit is what makes it safe to delete the
 * directory afterwards.
 *
 * @since 1.0.0
 * @category destructors
 */
export const reapWaitChildren = async (): Promise<void> => {
  const hosts = [...owned]
  owned.clear()
  await Promise.all(hosts.map(async (host) => {
    if (host.process.exitCode === null && host.process.signalCode === null) {
      try {
        process.kill(host.pid, "SIGKILL")
      } catch {
        // Already gone: its case killed it, or it exited on its own.
      }
    }
    await host.exited
  }))
}
