/**
 * `NodeHost` again, but taking every default the contract offers: the default
 * scratch path, the default command set, and — unlike the other bundles —
 * an HTTP client that is expected to *succeed*, against a loopback server
 * started for the run. A client that only ever refuses a connection never
 * proves the response actually comes back.
 */
import { runHostContract } from "@smthrs/kernel/test/contract"
import * as Effect from "effect/Effect"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import { execFileSync, spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, expect } from "vitest"
import * as NodeHost from "../../src/NodeHost.ts"

const jjAvailable = spawnSync("jj", ["--version"], { stdio: "ignore" }).status === 0
const jjRoot = mkdtempSync(join(tmpdir(), "flows-node-host-contract-jj-"))
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
  if (listening === undefined) {
    return undefined
  }
  return new Promise<void>((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error))
  })
})

runHostContract("NodeHost defaults", NodeHost.layerAt(jjRoot), {
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
