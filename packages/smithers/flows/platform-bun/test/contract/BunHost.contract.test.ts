/**
 * Contract for the layer `BunHost` selects on the current runtime.
 *
 * The Node lane collects coverage; `:bunTest` re-runs these contracts in Bun
 * workers to exercise native fetch, subprocesses, and filesystem helpers.
 *
 * The HTTP probes run against a loopback server started for the run, so the
 * success path is asserted rather than only connection refusal; a client that
 * can merely fail to reach a closed port never proves a response comes back.
 * The server is mandatory for that reason: a bind failure throws out of this
 * module rather than degrading to the closed-port shape, which would report
 * green while asserting nothing about the success path this file exists for.
 */
import { describe, expect, it } from "@effect/vitest"
import { runHostContract } from "@smthrs/kernel/test/contract"
import { Deferred, Effect, Fiber, Schedule } from "effect"
import { HttpClient } from "effect/unstable/http/HttpClient"
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

/**
 * Echoes a request body back when there is one, so a caller can prove the bytes
 * it sent arrived, and answers `host-contract` otherwise.
 */
const server = createServer((request, response) => {
  if (request.url === "/redirect") {
    response.writeHead(302, { location: "/must-not-follow" })
    response.end()
    return
  }
  const chunks: Array<Buffer> = []
  request.on("data", (chunk: Buffer) => void chunks.push(chunk))
  request.on("end", () => {
    const sent = Buffer.concat(chunks).toString("utf8")
    response.writeHead(200, {
      "content-type": "text/plain",
      "x-host-contract": `${request.method}:${request.url}`
    })
    response.end(sent === "" ? "host-contract" : sent)
  })
})
server.unref()
const listening = await new Promise<number>((resolve, reject) => {
  const onError = (error: Error) =>
    reject(
      new Error(
        "the BunHost contract needs a loopback HTTP server; binding 127.0.0.1:0 failed",
        { cause: error }
      )
    )
  server.once("error", onError)
  server.listen(0, "127.0.0.1", () => {
    server.off("error", onError)
    resolve((server.address() as AddressInfo).port)
  })
}).catch((error: unknown) => {
  // `afterAll` is not registered yet, so the jj directories made above would
  // outlive a bind failure unless they are removed on the way out.
  rmSync(jjWorkspacePath, { recursive: true, force: true })
  rmSync(jjRoot, { recursive: true, force: true })
  throw error
})

afterAll(() => {
  rmSync(jjWorkspacePath, { recursive: true, force: true })
  rmSync(jjRoot, { recursive: true, force: true })
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
  httpClient: {
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

/**
 * The shared contract inspects a response's status and headers but never its
 * body, because `assertResponse` is synchronous and reading a body is an
 * `Effect`. A client that returned every header and no bytes would satisfy it,
 * so the payload is observed here instead.
 */
describe("BunHost HttpClient payloads", () => {
  it.effect("returns the bytes the server wrote, on both request shapes", () =>
    Effect.gen(function*() {
      const bodies = yield* Effect.gen(function*() {
        const client = yield* HttpClient
        const read = yield* client.execute(HttpClientRequest.get(`http://127.0.0.1:${listening}/payload`))
        const written = yield* client.execute(
          HttpClientRequest.post(`http://127.0.0.1:${listening}/payload`).pipe(
            HttpClientRequest.bodyText("sent-by-the-bun-client")
          )
        )
        return { read: yield* read.text, written: yield* written.text }
      }).pipe(Effect.provide(BunHost.layer))

      // The server echoes a request body it received, so the second value is
      // proof the outgoing bytes arrived and not just that a response came back.
      expect(bodies).toEqual({ read: "host-contract", written: "sent-by-the-bun-client" })
    }))
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

describe.skipIf(process.platform === "win32")("BunHost child-process lifecycle", () => {
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
