/**
 * Spawning the parking host and its replacement.
 *
 * @since 1.0.0
 */
import { type ChildProcess, spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import type { WaitMode, WaitOptions } from "./waitFlows.ts"

const runner = fileURLToPath(new URL("../fixtures/waitChild.ts", import.meta.url))

/** What the child does with the run it finds. */
export type WaitPhase = "linger" | "settle" | "resolve" | "notify"

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

  const read = (chunk: string): void => {
    out += chunk
    const park = /PARKED=(.+)\n/.exec(out)
    if (park !== null) announceParked(park[1] as string)
    const settle = /SETTLED=(.*)\n/.exec(out)
    if (settle !== null) announceSettled(JSON.parse(settle[1] as string))
  }
  child.stdout?.on("data", read)
  child.stderr?.on("data", (chunk: string) => {
    err += chunk
  })

  const exited = new Promise<number | null>((resolve) => {
    child.once("exit", (code) => {
      refuse(new Error(`wait child exited with ${String(code)}\n${err}`))
      resolve(code)
    })
  })

  return { process: child, pid, stdout: () => out, stderr: () => err, exited, parked, settled }
}
