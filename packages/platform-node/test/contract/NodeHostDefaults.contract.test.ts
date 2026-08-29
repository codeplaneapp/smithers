/**
 * `NodeHost` again, but taking every default the contract offers: the default
 * scratch path, the default command set, and — unlike the other bundles —
 * an HTTP client that is expected to *succeed*, against a loopback server
 * started for the run. A client that only ever refuses a connection never
 * proves the response actually comes back.
 */
import { runHostContract } from "@smthrs/kernel/test/contract"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import { spawnSync } from "node:child_process"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { afterAll, expect } from "vitest"
import * as NodeHost from "../../src/NodeHost.ts"

const jjAvailable = spawnSync("jj", ["--version"], { stdio: "ignore" }).status === 0
const jjStatusWorks = jjAvailable && spawnSync("jj", ["status"], { stdio: "ignore" }).status === 0

const server = createServer((request, response) => {
  response.writeHead(200, { "content-type": "text/plain", "x-host-contract": `echo:${request.url}` })
  response.end("host-contract")
})
server.unref()
const listening = await new Promise<number | undefined>((resolve) => {
  server.once("error", () => resolve(undefined))
  server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port))
})
afterAll(() => {
  if (listening === undefined) {
    return undefined
  }
  return new Promise<void>((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error))
  })
})

runHostContract("NodeHost defaults", NodeHost.layer, {
  fileSystem: { expected: "success" },
  path: { expected: "success" },
  childProcess: { expected: "success" },
  jj: jjStatusWorks
    ? { expected: "success" }
    : { expected: "failure", code: jjAvailable ? "unknown" : "not_installed" },
  httpClient: listening === undefined
    ? { expected: "failure", code: "TransportError" }
    : {
      expected: "success",
      request: HttpClientRequest.get(`http://127.0.0.1:${listening}/probe`),
      assertResponse: (response) => {
        expect(response.status).toBe(200)
        // Proves the loopback server answered this exact request, not a cache or
        // a redirect: the header echoes the path the client asked for.
        expect(response.headers["x-host-contract"]).toBe("echo:/probe")
      }
    }
})
