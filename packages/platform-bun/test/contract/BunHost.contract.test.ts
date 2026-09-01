/**
 * Contract for the layer `BunHost` selects on the current runtime.
 *
 * Under Node — which is what vitest and CI run — the Bun modules resolve to
 * Node implementations by design, so these assertions describe the fallback,
 * NOT the Bun-only code paths. `@effect/platform-bun`'s
 * `BunChildProcessSpawner` is `@effect/platform-node-shared`'s spawner
 * re-exported, so process spawning is literally the same implementation on
 * both runtimes and needs no separate Bun fake.
 */
import { describe, expect, it } from "@effect/vitest"
import { runHostContract } from "@smthrs/kernel/test/contract"
import { Deferred, Effect, Fiber, Schedule } from "effect"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { execFileSync, spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll } from "vitest"
import * as BunHost from "../../src/BunHost.ts"

const jjAvailable = spawnSync("jj", ["--version"], { stdio: "ignore" }).status === 0
const jjRoot = mkdtempSync(join(tmpdir(), "flows-bun-host-contract-jj-"))
if (jjAvailable) execFileSync("jj", ["git", "init", jjRoot], { stdio: "ignore" })
const jjStatusWorks = jjAvailable && spawnSync("jj", ["status"], { cwd: jjRoot, stdio: "ignore" }).status === 0
const jjWorkspacePath = `${jjRoot}-workspace`
afterAll(() => {
  rmSync(jjWorkspacePath, { recursive: true, force: true })
  rmSync(jjRoot, { recursive: true, force: true })
})

runHostContract("BunHost", BunHost.layerAt(jjRoot), {
  fileSystem: { expected: "success" },
  path: { expected: "success" },
  childProcess: { expected: "success" },
  jj: jjStatusWorks
    ? {
      expected: "success",
      prepareChange: (phase) => Effect.sync(() => writeFileSync(join(jjRoot, `${phase}.txt`), phase)),
      workspacePath: jjWorkspacePath,
      rootFrom: jjRoot
    }
    : { expected: "failure", code: jjAvailable ? "unknown" : "not_installed" },
  httpClient: { expected: "failure", code: "TransportError" }
})

const nodeErrorCode = (error: unknown): unknown =>
  typeof error === "object" && error !== null && "code" in error ? error.code : undefined

const waitForEsrch = (pid: number) =>
  Effect.retry(
    Effect.suspend(() => {
      try {
        process.kill(pid, 0)
        return Effect.fail("alive" as const)
      } catch (error) {
        return nodeErrorCode(error) === "ESRCH" ? Effect.void : Effect.die(error)
      }
    }),
    { times: 400, schedule: Schedule.spaced(5) }
  )

describe.skipIf(process.platform === "win32")("BunHost child-process lifecycle under Node", () => {
  it.effect("reaps the child OS process when its owning fiber is interrupted", () =>
    Effect.gen(function*() {
      const pid = yield* (
        Effect.gen(function*() {
          const spawner = yield* ChildProcessSpawner
          const pidReady = Deferred.makeUnsafe<number>()
          const fiber = yield* Effect.forkChild(
            Effect.scoped(
              Effect.gen(function*() {
                const handle = yield* spawner.spawn(ChildProcess.make("sleep", ["10"]))
                yield* Deferred.succeed(pidReady, Number(handle.pid))
                yield* handle.exitCode
              })
            ),
            { startImmediately: true }
          )
          const pid = yield* Deferred.await(pidReady)
          expect(() => process.kill(pid, 0)).not.toThrow()
          yield* Fiber.interrupt(fiber)
          return pid
        }).pipe(Effect.provide(BunHost.layer))
      )

      yield* (waitForEsrch(pid))
      let livenessError: unknown
      try {
        process.kill(pid, 0)
      } catch (error) {
        livenessError = error
      }
      expect(livenessError).toMatchObject({ code: "ESRCH" })
    }))
})
