/**
 * Two control planes reaching for one suspended run at the same instant.
 *
 * The fence being tested is a compare-and-swap in `flows_runs`, so the race has
 * to be real: two operating-system processes, two `SqlControlRuntime`s with
 * different owner identities, one SQLite file. A barrier file holds both
 * racers after they have paid their startup cost, which is what stops the
 * result from being decided by whichever process finished loading first.
 *
 * @since 1.0.0
 */
import { type ChildProcess, spawn } from "node:child_process"
import { writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const runner = fileURLToPath(new URL("../fixtures/claimChild.ts", import.meta.url))

const spawnChild = (args: ReadonlyArray<string>): {
  readonly process: ChildProcess
  readonly stdout: () => string
  readonly stderr: () => string
  readonly ready: Promise<void>
  readonly done: Promise<string>
} => {
  const child = spawn(process.execPath, [runner, ...args], { stdio: ["ignore", "pipe", "pipe"] })
  let out = ""
  let err = ""
  let announceReady: () => void = () => {}
  let announceDone: (line: string) => void = () => {}
  let refuse: (cause: unknown) => void = () => {}
  const ready = new Promise<void>((resolve, reject) => {
    announceReady = resolve
    refuse = reject
  })
  const done = new Promise<string>((resolve, reject) => {
    announceDone = resolve
    const previous = refuse
    refuse = (cause) => {
      previous(cause)
      reject(cause)
    }
  })
  ready.catch(() => {})
  done.catch(() => {})
  child.stdout?.setEncoding("utf8")
  child.stderr?.setEncoding("utf8")
  child.stdout?.on("data", (chunk: string) => {
    out += chunk
    if (out.includes("READY\n")) announceReady()
    const line = /(RUN|CLAIM)=(.+)\n/.exec(out)
    if (line !== null) announceDone(line[2] as string)
  })
  child.stderr?.on("data", (chunk: string) => {
    err += chunk
  })
  child.once("exit", (code) => {
    refuse(new Error(`claim child exited with ${String(code)}\n${out}\n${err}`))
  })
  return { process: child, stdout: () => out, stderr: () => err, ready, done }
}

/**
 * Plans, approves, launches, and parks a run, leaving it suspended and
 * unowned. Returns its id.
 *
 * @since 1.0.0
 * @category constructors
 */
export const suspendedRun = async (filename: string): Promise<string> =>
  spawnChild([filename, "setup", "0", "setup"]).done

/**
 * What one racer got back.
 *
 * @since 1.0.0
 * @category models
 */
export interface ClaimAttempt {
  readonly hostId: string
  /** `won:<receipt tag>` or `lost:<error tag>`. */
  readonly outcome: string
}

/**
 * Races `hostIds` for `runId` and returns what each one got.
 *
 * @since 1.0.0
 * @category constructors
 */
export const raceForClaim = async (
  filename: string,
  runId: string,
  barrier: string,
  hostIds: ReadonlyArray<string>
): Promise<ReadonlyArray<ClaimAttempt>> => {
  const racers = hostIds.map((hostId, index) => ({
    hostId,
    child: spawnChild([filename, hostId, String(200 + index), "resume", runId, barrier])
  }))
  await Promise.all(racers.map((racer) => racer.child.ready))
  writeFileSync(barrier, "go\n")
  const outcomes = await Promise.all(racers.map((racer) => racer.child.done))
  return racers.map((racer, index) => ({ hostId: racer.hostId, outcome: outcomes[index] as string }))
}
