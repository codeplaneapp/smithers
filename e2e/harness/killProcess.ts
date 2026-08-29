/**
 * Real process kills, and the questions a test asks after one.
 *
 * Nothing here simulates a crash. `killProcess` sends a real signal to a real
 * pid and refuses to return until the operating system has reaped it, so a
 * suite can never claim it injected a fault against a process that was already
 * dead. The orphan helpers answer the question a kill leaves behind: a child
 * the killed process started is reparented to init, and a runtime that claims
 * containment has to be the thing that reaps it.
 *
 * @since 1.0.0
 */
import { execFileSync } from "node:child_process"

const pollIntervalMs = 25
const defaultTimeoutMs = 5_000

/**
 * Whether a pid names a live process.
 *
 * Signal 0 performs the permission and existence check without delivering
 * anything. `ESRCH` is the only answer that means "gone"; `EPERM` means the
 * process exists and belongs to somebody else.
 *
 * @since 1.0.0
 * @category refinements
 */
export const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH"
  }
}

/**
 * Whether a process group still has a member.
 *
 * A negative pid addresses the whole group, which is the unit
 * `NodeRuntime.layerHost` containment works in.
 *
 * @since 1.0.0
 * @category refinements
 */
export const isGroupAlive = (pgid: number): boolean => {
  try {
    process.kill(-pgid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH"
  }
}

/**
 * The parent pid the operating system currently records for `pid`, or
 * `undefined` when the process is gone.
 *
 * This is the orphan test. A child whose parent was killed is reparented, and
 * on macOS and Linux the new parent is pid 1 (or a subreaper). A fault suite
 * that asserts containment has to read this rather than assume it.
 *
 * @since 1.0.0
 * @category getters
 */
export const parentPid = (pid: number): number | undefined => {
  try {
    const output = execFileSync("ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf8" }).trim()
    if (output.length === 0) return undefined
    const parsed = Number(output.split(/\s+/)[0])
    return Number.isFinite(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Waits until `predicate` holds, or fails with `label` in the message.
 *
 * @since 1.0.0
 * @category utils
 */
export const waitFor = async (
  predicate: () => boolean,
  label: string,
  timeoutMs = defaultTimeoutMs
): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (predicate()) return
    if (Date.now() >= deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`)
    await sleep(pollIntervalMs)
  }
}

/**
 * Waits until the operating system has reparented `pid` away from `expected`,
 * and returns the parent it settled on.
 *
 * Reparenting is not instantaneous: the kernel moves the child when the old
 * parent is reaped, which is after the signal is delivered. A suite that reads
 * `parentPid` once races that.
 *
 * @since 1.0.0
 * @category getters
 */
export const waitForReparent = async (
  pid: number,
  expected: number,
  timeoutMs = defaultTimeoutMs
): Promise<number> => {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const parent = parentPid(pid)
    if (parent === undefined) throw new Error(`pid ${pid} exited before it could be reparented`)
    if (parent !== expected) return parent
    if (Date.now() >= deadline) {
      throw new Error(`pid ${pid} still reports parent ${expected} after ${timeoutMs}ms`)
    }
    await sleep(pollIntervalMs)
  }
}

/**
 * Sends `signal` to a real pid and waits for it to leave.
 *
 * A pid that is already dead is an error rather than a no-op: the test that
 * called this believed it was injecting a fault, and it was not.
 *
 * @since 1.0.0
 * @category constructors
 */
export const killProcess = async (
  handle: { readonly pid?: number | undefined },
  signal: NodeJS.Signals = "SIGKILL",
  timeoutMs = defaultTimeoutMs
): Promise<void> => {
  const pid = handle.pid
  if (typeof pid !== "number" || !Number.isFinite(pid)) {
    throw new Error(`killProcess: invalid pid ${String(pid)}`)
  }
  try {
    process.kill(pid, signal)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") {
      throw new Error(`killProcess: pid ${pid} was already dead, so ${signal} injected nothing`)
    }
    throw error
  }
  await waitFor(() => !isAlive(pid), `pid ${pid} to exit after ${signal}`, timeoutMs)
}

/**
 * Kills a whole process group, used to clean up what a test deliberately
 * orphaned. Never throws: this is teardown.
 *
 * @since 1.0.0
 * @category constructors
 */
export const killGroup = (pgid: number, signal: NodeJS.Signals = "SIGKILL"): void => {
  try {
    process.kill(-pgid, signal)
  } catch {
    // Already gone; teardown has nothing left to do.
  }
}
