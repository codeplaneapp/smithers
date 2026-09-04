/**
 * Kill a host, and watch the next one clean up after it.
 *
 * Cancelling a run interrupts fibers, and closing a scope signals the children
 * that scope still holds a handle for. Neither of those happens when the host
 * process is KILLED: no finalizer runs, and the agents it started keep running
 * with nobody left to signal them.
 *
 * `NodeRuntime.layerHost` closes that hole with two pieces that only make sense
 * together. Every child it spawns leads its own process group and is recorded
 * in the durable `ProcessLedger` under the host's id; and every host, on the way
 * up, reads the records earlier incarnations of the SAME host id left behind,
 * kills the groups whose owner is gone, and journals
 * `flows.host.process-reaped.v1` so a third incarnation does not try the same
 * kill against a pid the operating system has since handed to somebody else.
 *
 * The first phase is a real child process, killed with `SIGKILL`, because a
 * host that shuts down politely proves the opposite of what this example is
 * about.
 */
import { Journal, Kernel } from "@smthrs/flows"
import * as NodeRuntime from "@smthrs/flows/NodeRuntime"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { spawn } from "node:child_process"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

/** The host id both incarnations share. It is what makes the records theirs. */
export const hostId = "examples/host-containment"

const hostProgram = join(dirname(fileURLToPath(import.meta.url)), "37-host-containment-host.ts")

export interface Summary {
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
const killHost = (filename: string): Promise<number> =>
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
    child.on("exit", () => {
      if (pgid === undefined) reject(new Error(`the host exited before announcing a group: ${stderr}`))
      else resolve(pgid)
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

export const main = (filename: string): Effect.Effect<Summary> =>
  Effect.gen(function*() {
    // ----------------------------------------------------------------- crash
    const pgid = yield* Effect.promise(() => killHost(filename))
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
        NodeRuntime.layerHost({ filename, workspaceRoot: dirname(filename), owner: { hostId }, signals: [] }, Layer.empty)
      ),
      Effect.orDie,
      Effect.scoped
    )

    const survivedTheReaper = !(yield* Effect.promise(() => waitForGroupExit(pgid, 10_000)))
    return { pgid, orphaned, survivedTheReaper, hostEvents }
  })
