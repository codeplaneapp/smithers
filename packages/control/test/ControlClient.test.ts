import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient"
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer"
import * as NodeSocket from "@effect/platform-node/NodeSocket"
import { Cause, Effect, Layer, Stream } from "effect"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import { RpcSerialization } from "effect/unstable/rpc"
import { createServer } from "node:http"
import { describe, expect, it } from "vitest"
import { Control } from "../src/Control.ts"
import * as ControlClient from "../src/ControlClient.ts"
import { RunNotFound, TransportError, Unauthorized } from "../src/ControlError.ts"
import * as ControlRpcs from "../src/ControlRpcs.ts"
import * as ControlServer from "../src/ControlServer.ts"
import * as TestStack from "./TestStack.ts"

const token = "control-client-secret"

const auth = ControlRpcs.layerBearerAuth({
  token,
  principal: { id: "remote-operator", kind: "bearer" },
  now: () => 1
})

const served = (authentication: Layer.Layer<ControlRpcs.ControlAuth> = auth) =>
  HttpRouter.serve(
    ControlServer.layerHttp.pipe(
      Layer.provide(authentication),
      Layer.provide(RpcSerialization.layerNdjson)
    ),
    { disableListenLog: true, disableLogger: true }
  ).pipe(
    Layer.provideMerge(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 })),
    Layer.provideMerge(TestStack.live())
  )

const baseUrl = Effect.map(HttpServer.HttpServer, (server) => {
  if (server.address._tag !== "TcpAddress") throw new Error("expected a TCP control server")
  return `http://127.0.0.1:${server.address.port}`
})

const client = (url: string, credential?: string | undefined) =>
  ControlClient.layer(credential === undefined ? { url: `${url}/rpc` } : { url: `${url}/rpc`, credential }).pipe(
    Layer.provide([
      NodeHttpClient.layerUndici,
      NodeSocket.layerWebSocket(`${url.replace("http://", "ws://")}/rpc/ws`),
      RpcSerialization.layerNdjson
    ])
  )

const withClient = <A, E>(
  url: string,
  credential: string | undefined,
  use: (control: Control["Service"]) => Effect.Effect<A, E>
) =>
  Effect.gen(function*() {
    const control = yield* Control
    return yield* use(control)
  }).pipe(Effect.provide(client(url, credential)))

const run = <A, E>(effect: Effect.Effect<A, E, HttpServer.HttpServer>) =>
  Effect.runPromise(effect.pipe(Effect.provide(served()), Effect.scoped))

const transport = (error: unknown): TransportError => {
  expect(error).toBeInstanceOf(TransportError)
  return error as TransportError
}

const closedPort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (address === null || typeof address === "string") {
        server.close()
        reject(new Error("expected an ephemeral TCP port"))
        return
      }
      server.close((cause) => cause === undefined ? resolve(address.port) : reject(cause))
    })
  })

const rawServer = (status: number, body: string): Promise<{
  readonly url: string
  readonly close: () => Promise<void>
}> =>
  new Promise((resolve, reject) => {
    const server = createServer((_request, response) => {
      response.statusCode = status
      response.setHeader("content-type", "application/x-ndjson")
      response.end(body)
    })
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (address === null || typeof address === "string") {
        server.close()
        reject(new Error("expected an ephemeral TCP port"))
        return
      }
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        close: () => new Promise<void>((closed, failed) =>
          server.close((cause) => cause === undefined ? closed() : failed(cause)))
      })
    })
  })

describe("ControlClient", () => {
  it("completes a unary round trip through the real HTTP server", async () => {
    const listed = await run(Effect.gen(function*() {
      const url = yield* baseUrl
      return yield* withClient(url, token, (control) => control.list({ _tag: "flows" }))
    }))

    expect(listed._tag).toBe("flows")
  })

  it("sends the bearer header and preserves an Unauthorized response", async () => {
    const result = await run(Effect.gen(function*() {
      const url = yield* baseUrl
      const refused = yield* withClient(url, "wrong-token", (control) =>
        control.list({ _tag: "flows" }).pipe(Effect.flip))
      const accepted = yield* withClient(url, token, (control) => control.list({ _tag: "flows" }))
      return { accepted, refused }
    }))

    expect(result.refused).toBeInstanceOf(Unauthorized)
    expect(result.accepted._tag).toBe("flows")
  })

  it("preserves a declared control failure", async () => {
    const error = await run(Effect.gen(function*() {
      const url = yield* baseUrl
      return yield* withClient(url, token, (control) =>
        control.run({
          _tag: "Resume",
          runId: "missing-run",
          idempotencyKey: "resume-missing"
        }).pipe(Effect.flip))
    }))

    expect(error).toBeInstanceOf(RunNotFound)
    expect((error as RunNotFound).runId).toBe("missing-run")
  })

  it("marks a refused connection retryable without exposing the socket message", async () => {
    const port = await closedPort()
    const error = await Effect.runPromise(
      withClient(`http://127.0.0.1:${port}`, token, (control) =>
        control.list({ _tag: "flows" }).pipe(Effect.flip)).pipe(Effect.scoped)
    )

    const failure = transport(error)
    expect(failure.retryable).toBe(true)
    expect(failure.message).toBe("The control server could not be reached.")
    expect(failure.cause).toBeDefined()
  })

  it("turns a client request encoding defect into a non-retryable failure", async () => {
    const exit = await run(Effect.gen(function*() {
      const url = yield* baseUrl
      return yield* withClient(url, token, (control) =>
        Effect.exit(control.plan({ flowId: "system/test", input: new Date(0) })))
    }))

    if (exit._tag === "Success") throw new Error("expected request encoding to fail")
    const failure = transport(Cause.squash(exit.cause))
    expect(failure.retryable).toBe(false)
    expect(failure.message).toBe("The control request could not be encoded.")
    expect(failure.cause).toBeDefined()
  })

  it("classifies HTTP 4xx as final and HTTP 5xx as retryable", async () => {
    const clientFailure = await rawServer(400, "bad request")
    const serverFailure = await rawServer(503, "unavailable")
    try {
      const rejected = transport(await Effect.runPromise(
        withClient(clientFailure.url, token, (control) =>
          control.list({ _tag: "flows" }).pipe(Effect.flip)).pipe(Effect.scoped)
      ))
      const unavailable = transport(await Effect.runPromise(
        withClient(serverFailure.url, token, (control) =>
          control.list({ _tag: "flows" }).pipe(Effect.flip)).pipe(Effect.scoped)
      ))

      expect(rejected.retryable).toBe(false)
      expect(rejected.message).toBe("The control server rejected the HTTP request.")
      expect(unavailable.retryable).toBe(true)
      expect(unavailable.message).toBe("The control server failed while handling the HTTP request.")
    } finally {
      await Promise.all([clientFailure.close(), serverFailure.close()])
    }
  })

  it("classifies an invalid RPC response as a non-retryable decode failure", async () => {
    const malformed = await rawServer(200, "not an RPC response\n")
    try {
      const failure = transport(await Effect.runPromise(
        withClient(malformed.url, token, (control) =>
          control.list({ _tag: "flows" }).pipe(Effect.flip)).pipe(Effect.scoped)
      ))

      expect(failure.retryable).toBe(false)
      expect(failure.message).toBe("The control response could not be decoded.")
      expect(failure.cause).toBeDefined()
    } finally {
      await malformed.close()
    }
  })

  it("streams watch snapshots over the real WebSocket mount", async () => {
    const events = await Effect.runPromise(
      Effect.gen(function*() {
        const url = yield* baseUrl
        return yield* withClient(url, undefined, (control) =>
          Effect.gen(function*() {
            yield* control.plan({ flowId: "system/test", input: { source: "websocket" } })
            return yield* Stream.runCollect(control.watch({ follow: false }))
          }))
      }).pipe(
        Effect.provide(served(ControlRpcs.layerNoopAuth())),
        Effect.scoped
      )
    )

    expect(events.length).toBeGreaterThan(0)
  })
})
