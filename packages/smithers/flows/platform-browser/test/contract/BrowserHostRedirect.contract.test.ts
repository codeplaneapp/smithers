/**
 * Network contracts for the fetch-backed HttpClient in BrowserHost.
 *
 * Vitest runs this browser bundle under Node, so a manual redirect is exposed
 * as a 302 here. In a real tab Fetch returns an opaque redirect instead; both
 * forms share the invariant that the second origin is never contacted.
 */
import { afterAll, beforeAll, describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { HttpClient } from "effect/unstable/http/HttpClient"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import * as fsModule from "node:fs"
import * as fsPromises from "node:fs/promises"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import type * as BrowserChildProcessSpawner from "../../src/BrowserChildProcessSpawner/index.ts"
import * as BrowserHost from "../../src/BrowserHost.ts"

const bash: BrowserChildProcessSpawner.JustBashLike = {
  exec: async () => ({ stdout: "", stderr: "", exitCode: 0 })
}

const layer = BrowserHost.layer({
  bash,
  fs: fsPromises,
  // Jj is lazy and this network-only contract never instantiates the module.
  jj: { wasm: new Uint8Array(0), fs: fsModule, root: "/" }
})

const listen = (server: Server): Promise<number> =>
  new Promise((resolve, reject) => {
    const onError = (error: Error) => reject(error)
    server.once("error", onError)
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError)
      resolve((server.address() as AddressInfo).port)
    })
  })

const close = (server: Server): Promise<void> => {
  if (!server.listening) return Promise.resolve()
  return new Promise((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error))
  })
}

let destinationHits = 0
let destinationPort = 0
let originPort = 0
const destination = createServer((_request, response) => {
  destinationHits += 1
  response.writeHead(200, { "content-type": "text/plain" })
  response.end("redirect destination")
})
const origin = createServer((request, response) => {
  if (request.url === "/success") {
    response.writeHead(200, { "content-type": "text/plain", "x-browser-host": "loopback" })
    response.end("browser response")
    return
  }
  response.writeHead(302, {
    location: `http://127.0.0.1:${destinationPort}/must-not-be-hit`
  })
  response.end()
})

beforeAll(async () => {
  destination.unref()
  origin.unref()
  destinationPort = await listen(destination)
  originPort = await listen(origin)
})

afterAll(async () => {
  await Promise.all([close(origin), close(destination)])
})

describe("BrowserHost HttpClient contract", () => {
  it.effect("returns a successful loopback GET response through the browser bundle", () =>
    Effect.gen(function*() {
      const response = yield* (
        Effect.gen(function*() {
          const client = yield* HttpClient
          const response = yield* client.execute(
            HttpClientRequest.get(`http://127.0.0.1:${originPort}/success`)
          )
          return {
            body: yield* response.text,
            header: response.headers["x-browser-host"],
            status: response.status
          }
        }).pipe(Effect.provide(layer))
      )

      expect(response).toEqual({ body: "browser response", header: "loopback", status: 200 })
    }))

  it.effect("does not follow a 302 redirect to a second origin", () =>
    Effect.gen(function*() {
      destinationHits = 0
      const response = yield* (
        Effect.gen(function*() {
          const client = yield* HttpClient
          const response = yield* client.execute(
            HttpClientRequest.get(`http://127.0.0.1:${originPort}/redirect`)
          )
          yield* response.text
          return { location: response.headers.location, status: response.status }
        }).pipe(Effect.provide(layer))
      )

      expect(response).toEqual({
        location: `http://127.0.0.1:${destinationPort}/must-not-be-hit`,
        status: 302
      })
      expect(destinationHits).toBe(0)
    }))
})
