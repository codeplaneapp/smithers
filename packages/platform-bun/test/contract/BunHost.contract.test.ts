/**
 * Contract for the layer `BunHost` selects on the current runtime.
 *
 * The suite runs on both interpreters: this package's vitest lane under Node,
 * which is where the coverage gate lives, and the `//ci:platformBun` target,
 * which re-runs these same files under Bun. `@effect/platform-bun`'s
 * `BunChildProcessSpawner` is `@effect/platform-node-shared`'s spawner
 * re-exported, so process spawning is literally the same implementation on
 * both runtimes and needs no separate Bun fake.
 *
 * The HTTP probes run against a loopback server started for the run, so the
 * success path is asserted rather than only connection refusal; a client that
 * can merely fail to reach a closed port never proves a response comes back.
 */
import { describe, expect, it } from "@effect/vitest"
import { runHostContract } from "@smthrs/kernel/test/contract"
import { Deferred, Effect, Fiber, Schedule } from "effect"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { execFileSync, spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll } from "vitest"
import * as BunHost from "../../src/BunHost.ts"

const jjAvailable = spawnSync("jj", ["--version"], { stdio: "ignore" }).status === 0
const jjRoot = mkdtempSync(join(tmpdir(), "flows-bun-host-contract-jj-"))
if (jjAvailable) execFileSync("jj", ["git", "init", jjRoot], { stdio: "ignore" })
const jjStatusWorks = jjAvailable && spawnSync("jj", ["status"], { cwd: jjRoot, stdio: "ignore" }).status === 0
const jjWorkspacePath = `${jjRoot}-workspace`

const server = createServer((request, response) => {
  if (request.url === "/redirect") {
    response.writeHead(302, { location: "/must-not-follow" })
    response.end()
    return
  }
  response.writeHead(200, {
    "content-type": "text/plain",
    "x-host-contract": `${request.method}:${request.url}`
  })
  response.end("host-contract")
})
server.unref()
const listening = await new Promise<number | undefined>((resolve) => {
  server.once("error", () => resolve(undefined))
  server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port))
})

afterAll(() => {
  rmSync(jjWorkspacePath, { recursive: true, force: true })
  rmSync(jjRoot, { recursive: true, force: true })
  if (listening === undefined) return undefined
  return new Promise<void>((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error))
  })
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
  httpClient: listening === undefined
    ? { expected: "failure", code: "TransportError" }
    : {
      expected: "success",
      read: {
        request: HttpClientRequest.get(`http://127.0.0.1:${listening}/read`),
        assertResponse: (response) => {
          expect(response.status).toBe(200)
          expect(response.headers["x-host-contract"]).toBe("GET:/read")
        }
      },
      write: {
        request: HttpClientRequest.post(`http://127.0.0.1:${listening}/write`).pipe(
          HttpClientRequest.bodyText("host-contract")
        ),
        assertResponse: (response) => {
          expect(response.status).toBe(200)
          expect(response.headers["x-host-contract"]).toBe("POST:/write")
        }
      },
      redirect: {
        request: HttpClientRequest.get(`http://127.0.0.1:${listening}/redirect`),
        assertResponse: (response) => {
          expect(response.status).toBe(302)
          expect(response.headers.location).toBe("/must-not-follow")
        }
      }
    }
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
