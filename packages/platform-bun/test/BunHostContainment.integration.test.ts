/**
 * The contained Bun host, driven over real processes.
 *
 * `BunHost.layerContained` is the reason this bundle is worth having under a
 * supervisor: it hands out the same five host services `BunHost.layer` does,
 * spawns every child through `@smthrs/kernel`'s `ContainedSpawner` so the child
 * leads a recorded group with a `SIGTERM`-then-`SIGKILL` deadline, builds `jj`
 * over that same spawner rather than letting it start children out the side,
 * and sweeps what a dead incarnation abandoned on the way up. The barrel suite
 * only proves the layers exist; these cases drive them.
 *
 * `it.live` throughout: every wait below is real elapsed time.
 */
import { describe, expect, it } from "@effect/vitest"
import { Jj } from "@smthrs/jj"
import * as ProcessLedger from "@smthrs/kernel/ProcessLedger"
import { Deferred, Effect, Fiber, Layer } from "effect"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { spawn } from "node:child_process"
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as BunHost from "../src/BunHost.ts"

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** Waits for a pid to disappear, or gives up after `budgetMs`. */
const waitForExit = async (pid: number, budgetMs: number): Promise<boolean> => {
  const deadline = Date.now() + budgetMs
  for (;;) {
    try {
      process.kill(pid, 0)
    } catch {
      return true
    }
    if (Date.now() > deadline) return false
    await sleep(10)
  }
}

/** Waits for a shim to report through a file that it is running. */
const waitForFile = async (path: string): Promise<string> => {
  for (let attempt = 0; attempt < 1_500; attempt += 1) {
    try {
      const text = readFileSync(path, "utf8").trim()
      if (text !== "") return text
    } catch {
      // not written yet
    }
    await sleep(10)
  }
  throw new Error(`the shim never wrote ${path}`)
}

/** A detached shell that leads its own group and has a background child. */
const startOrphanGroup = async (directory: string): Promise<{ leader: number; follower: number }> => {
  const pidFile = join(directory, "follower.pid")
  const child = spawn("sh", ["-c", `sleep 30 & echo $! > ${pidFile}; sleep 30`], {
    detached: true,
    stdio: "ignore"
  })
  child.unref()
  const follower = Number(await waitForFile(pidFile))
  return { leader: child.pid as number, follower }
}

/** A pid that is certainly not a running process any more. */
const exitedPid = async (): Promise<number> => {
  const child = spawn("sh", ["-c", "exit 0"], { stdio: "ignore" })
  const pid = child.pid as number
  await new Promise<void>((resolve) => child.on("close", () => resolve()))
  return pid
}

const temporaryDirectory = () => mkdtempSync(join(tmpdir(), "flows-bun-contained-"))

/** Installs `script` as an executable named `jj`, first on `PATH`. */
const installJjShim = (directory: string, script: string): void => {
  writeFileSync(join(directory, "jj"), script)
  chmodSync(join(directory, "jj"), 0o755)
  // Prepended, not replaced: the shim wins while `sh` and `sleep` stay reachable.
  process.env["PATH"] = `${directory}:${process.env["PATH"] ?? ""}`
}

describe.skipIf(process.platform === "win32")("BunHost.layerContained", () => {
  it.live("kills the group a dead incarnation abandoned, while the layer is built", () =>
    Effect.gen(function*() {
      const directory = temporaryDirectory()
      try {
        const group = yield* Effect.promise(() => startOrphanGroup(directory))
        const deadOwner = yield* Effect.promise(exitedPid)

        // The incarnation that started the process, and then died. Recording
        // through a real ledger is what stamps the record with the pid's real
        // start instant, which is the identity the reaper re-checks.
        const previous = yield* ProcessLedger.makeMemory({ hostId: "bun-reaped", ownerPid: deadOwner })
        const abandoned = yield* previous.record({
          pid: group.leader,
          pgid: group.leader,
          commandDigest: "sh -c sleep"
        })

        // This incarnation inherits that record and nothing else.
        const current = yield* ProcessLedger.makeMemory({ hostId: "bun-reaped", ownerPid: process.pid })
        const retired: Array<ProcessLedger.ProcessRecord> = []
        const inherited = ProcessLedger.ProcessLedger.of({
          ...current,
          orphans: Effect.succeed([abandoned]),
          reaped: (record) => Effect.sync(() => void retired.push(record))
        })

        // Building the layer is the whole trigger: no operation is run through it.
        yield* Effect.void.pipe(
          Effect.provide(
            BunHost.layerContained({ graceMs: 300 }).pipe(
              Layer.provide(Layer.succeed(ProcessLedger.ProcessLedger)(inherited))
            )
          ),
          Effect.scoped
        )

        expect(retired).toEqual([abandoned])
        expect(yield* Effect.promise(() => waitForExit(group.leader, 5_000))).toBe(true)
        // The background process nothing ever held a handle for died with it.
        expect(yield* Effect.promise(() => waitForExit(group.follower, 5_000))).toBe(true)
      } finally {
        rmSync(directory, { recursive: true, force: true })
      }
    }), 30_000)

  it.live("escalates to SIGKILL when a child ignores SIGTERM", () =>
    Effect.gen(function*() {
      const directory = temporaryDirectory()
      try {
        const graceMs = 400
        const marker = join(directory, "trapped.ready")
        const ledger = yield* ProcessLedger.makeMemory({ hostId: "bun-escalation", ownerPid: process.pid })
        // No root: `layerContained()` is the process-working-directory form, and
        // this is the one case that runs a real operation through it.
        const host = BunHost.layerContained({ graceMs }).pipe(
          Layer.provide(Layer.succeed(ProcessLedger.ProcessLedger)(ledger))
        )

        const pidReady = Deferred.makeUnsafe<number>()
        const fiber = yield* Effect.forkChild(
          Effect.gen(function*() {
            const spawner = yield* ChildProcessSpawner
            const handle = yield* spawner.spawn(
              ChildProcess.make("sh", [
                "-c",
                `trap "" TERM\necho ready > ${marker}\nwhile true; do sleep 0.2; done\n`
              ])
            )
            yield* Deferred.succeed(pidReady, Number(handle.pid))
            yield* handle.exitCode
          }).pipe(Effect.provide(host), Effect.scoped),
          { startImmediately: true }
        )

        const pid = yield* Deferred.await(pidReady)
        // Interrupting before the trap is installed would prove nothing.
        yield* Effect.promise(() => waitForFile(marker))
        expect(yield* ledger.live).toEqual([
          expect.objectContaining({ pid, pgid: pid })
        ])

        const before = Date.now()
        yield* Fiber.interrupt(fiber)

        // `trap "" TERM` means only the escalation could have ended it.
        expect(yield* Effect.promise(() => waitForExit(pid, graceMs + 5_000))).toBe(true)
        expect(Date.now() - before).toBeGreaterThanOrEqual(graceMs)
        expect(yield* ledger.live).toEqual([])
      } finally {
        rmSync(directory, { recursive: true, force: true })
      }
    }), 30_000)

  it.live("records the children `jj` starts, instead of letting them out the side", () =>
    Effect.gen(function*() {
      // `BunJj.layer` spawns through `node:child_process` directly, so a jj
      // child leads no group the host recorded and no reaper can ever find it.
      // Under containment the host builds jj over its OWN spawner, and this is
      // the observable difference: the invocation shows up in the ledger like
      // any other child.
      const directory = temporaryDirectory()
      const previousPath = process.env["PATH"]
      installJjShim(directory, "#!/bin/sh\npwd\n")

      try {
        const ledger = yield* ProcessLedger.makeMemory({ hostId: "bun-contained-jj", ownerPid: process.pid })
        const recorded: Array<string> = []
        const host = BunHost.layerContainedAt(directory, { graceMs: 300 }).pipe(
          Layer.provide(
            Layer.succeed(ProcessLedger.ProcessLedger)({
              ...ledger,
              record: (spawned) =>
                Effect.tap(
                  ledger.record(spawned),
                  (row) => Effect.sync(() => void recorded.push(row.commandDigest))
                )
            })
          )
        )

        const status = yield* Effect.flatMap(Jj, (jj) => jj.status()).pipe(Effect.provide(host), Effect.scoped)

        expect(status.trim()).toBe(realpathSync(directory))
        expect(recorded).toEqual(["jj status"])
        // The invocation finished, so the record was retired with it.
        expect(yield* ledger.live).toEqual([])
      } finally {
        process.env["PATH"] = previousPath
        rmSync(directory, { recursive: true, force: true })
      }
    }), 30_000)
})
