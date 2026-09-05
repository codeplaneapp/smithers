/**
 * Recover process cleanup after a host is killed with SIGKILL.
 *
 * The host records each spawned process group in the durable `ProcessLedger`. A
 * later incarnation of the same host ID inspects those records, reaps groups
 * whose owner is gone, and journals the result.
 *
 * The companion host program runs in a separate process so the example can kill
 * it without running its finalizers. This exercises recovery that a graceful
 * shutdown would not test.
 */
import { Journal, Kernel } from "@smthrs/flows"
import * as NodeRuntime from "@smthrs/flows/NodeRuntime"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { spawn } from "node:child_process"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

/**
 * The host id both incarnations share. It is what makes the records theirs.
 * @since 1.0.0-rc.0
 * @category constants
 */
export const hostId = "examples/host-containment"

const hostProgram = join(dirname(fileURLToPath(import.meta.url)), "37-host-containment-host.ts")

/**
 * Observations from the killed host and its replacement.
 * @since 1.0.0-rc.0
 * @category models
 */
export interface Summary {
  /** Diagnostics from the host before it was killed; empty on successful startup. */
  readonly hostStderr: string
  /** The process group the killed host started. */
  readonly pgid: number
  /** Whether that group survived the host, which is the problem to solve. */
  readonly orphaned: boolean
  /** Whether it survived the next incarnation, which is the answer. */
  readonly survivedTheReaper: boolean
  /** What the host's own journal run records, in order. */
  readonly hostEvents: ReadonlyArray<string>
}

const groupIsAlive = (pgid: number): boolean => {
  try {
    process.kill(-pgid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * Runs the host until it reports the group it started, kills it, and waits for
 * the operating system to reap it so its pid genuinely reads as gone.
 */
const killHost = (filename: string): Promise<{ readonly pgid: number; readonly hostStderr: string }> =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [hostProgram, filename, hostId], { stdio: ["ignore", "pipe", "pipe"] })
    let announced = ""
    let stderr = ""
    let pgid: number | undefined
    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")
    child.stdout.on("data", (chunk: string) => {
      announced += chunk
      if (pgid === undefined && announced.includes("\n")) {
        pgid = Number(announced.split("\n")[0])
        // No handler runs for this, which is the whole point.
        child.kill("SIGKILL")
      }
    })
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk
    })
    child.on("error", reject)
    child.on("close", () => {
      if (pgid === undefined) reject(new Error(`the host exited before announcing a group: ${stderr}`))
      else resolve({ pgid, hostStderr: stderr })
    })
  })

/** Waits until `pgid` is gone, or gives up after `budgetMs`. */
const waitForGroupExit = (pgid: number, budgetMs: number): Promise<boolean> =>
  new Promise((resolve) => {
    const deadline = Date.now() + budgetMs
    const poll = () => {
      if (!groupIsAlive(pgid)) return resolve(true)
      if (Date.now() > deadline) return resolve(false)
      setTimeout(poll, 25)
    }
    poll()
  })

/**
 * Starts, kills, and replaces a host over the same durable journal.
 * @since 1.0.0-rc.0
 * @category examples
 */
export const main = (filename: string): Effect.Effect<Summary> =>
  Effect.gen(function*() {
    // ----------------------------------------------------------------- crash
    const { pgid, hostStderr } = yield* Effect.promise(() => killHost(filename))
    const orphaned = groupIsAlive(pgid)

    // --------------------------------------------------------------- restart
    // A new host, given nothing about the dead one but its id. Building the
    // layer IS the sweep: the reaper runs while the host stands up, so by the
    // time this body runs the decision has already been made and journaled.
    const hostEvents = yield* Effect.gen(function*() {
      const journal = yield* Journal.Journal.Journal
      const page = yield* journal.entries({
        runId: Kernel.ProcessLedger.hostRunId(hostId),
        limit: 16
      })
      return page.entries.map((entry) => entry.eventType)
    }).pipe(
      Effect.provide(
        NodeRuntime.layerHost(
          { filename, workspaceRoot: dirname(filename), owner: { hostId }, signals: [] },
          Layer.empty
        )
      ),
      Effect.orDie,
      Effect.scoped
    )

    const survivedTheReaper = !(yield* Effect.promise(() => waitForGroupExit(pgid, 10_000)))
    return { pgid, hostStderr, orphaned, survivedTheReaper, hostEvents }
  })
