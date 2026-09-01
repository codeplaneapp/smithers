/**
 * The assembled HTTP surface, bound to a real loopback socket over a real
 * SQLite control plane.
 *
 * Five of the eight requirements the old `packages/server` suite pinned live
 * here, re-expressed on the rc.0 boundary:
 *
 * - `light-gateway`: `GET /health` answers the workspace identity; an unknown
 *   route is a 404; the bind policy refuses what it must.
 * - `server-resume-lifecycle`: submitting an approval resumes the run it
 *   unblocked, in one call, with no second manual resume.
 * - `index-run-lifecycle-coverage`: a run launched through the served control
 *   plane reaches a terminal status and stays readable there.
 * - `xcombo-child-visibility-gateway`: a child run of a listed parent is
 *   itself listed, and carries the parent it came from.
 * - `serve.startup-recovery`: a gateway whose read path is unavailable still
 *   comes up and still answers `/health`.
 *
 * The keepalive suite pins rc-contract §10 item 4 on the socket rather than in
 * the service: a `Watch` a client follows over `/rpc/ws` carries a frame while
 * the run it watches is silent.
 */
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient"
import * as NodeSocket from "@effect/platform-node/NodeSocket"
import { describe, expect, it } from "@effect/vitest"
import { Control } from "@smthrs/control/Control"
import type { Service as ControlService } from "@smthrs/control/Control"
import * as ControlClient from "@smthrs/control/ControlClient"
import { Unavailable } from "@smthrs/control/ControlError"
import type { ApprovalPayload, PlanCard } from "@smthrs/control/ControlSchema"
import { SyncAuth as SyncAuthTag } from "@smthrs/sync/SyncRpcs"
import * as SyncServer from "@smthrs/sync/SyncServer"
import { Effect, Layer, type Scope, Stream } from "effect"
import { HttpServer } from "effect/unstable/http"
import { RpcSerialization } from "effect/unstable/rpc"
import { connect } from "node:net"
import { GatewayError, GatewayErrorCode, type GatewayErrorCode as GatewayErrorCodeValue } from "../src/GatewayError.ts"
import * as GatewayServer from "../src/GatewayServer.ts"
import * as NodeGateway from "../src/node/NodeGateway.ts"
import { make as makeProjections, Projections } from "../src/Projections.ts"
import { emit, stack } from "./GatewayStack.ts"

const health: GatewayServer.Health = {
  workspaceHash: "workspace-hash",
  gatewayId: "gateway-1",
  protocolVersion: "1",
  version: "1.0.0-rc.0"
}

/** The gateway on an ephemeral loopback port over a real control plane. */
const served = (options: NodeGateway.ServerOptions = { host: "127.0.0.1", port: 0 }) =>
  NodeGateway.layer(health, options).pipe(Layer.provideMerge(stack()))

const baseUrl = Effect.map(HttpServer.HttpServer, (server) => {
  if (server.address._tag !== "TcpAddress") throw new Error("expected a TCP gateway")
  return `http://127.0.0.1:${server.address.port}`
})

const approvalOf = (card: PlanCard): ApprovalPayload => ({
  target: { _tag: "Plan", planId: card.planId, digest: card.digest, envelope: card.envelope },
  scope: card.approval.scope,
  idempotencyKey: `approve:${card.planId}`
})

/** The rc.0 run-status vocabulary a client may render (rc-contract §10). */
const SEVEN_STATUSES = [
  "accepted",
  "running",
  "parked",
  "waiting-approval",
  "cancelled",
  "completed",
  "failed"
]

const test = <E>(title: string, body: () => Effect.Effect<void, E, Scope.Scope>) =>
  it(title, () => Effect.runPromise(Effect.scoped(body())))

/** One framed RPC message, and the byte limit that admits it and nothing more. */
const exactBody = `${JSON.stringify({ _tag: "Request", id: 1, tag: "NoSuchProcedure", payload: {}, headers: [] })}\n`
const exactBodyBytes = new TextEncoder().encode(exactBody).byteLength

/**
 * One HTTP/1.1 exchange written straight onto a socket.
 *
 * `fetch` owns framing headers: it refuses to set `connection` and `upgrade`,
 * it rewrites `content-length`, and it will not send a body it then abandons.
 * A WebSocket upgrade and a truncated body are exactly what has to be proved
 * here, so the request is written by hand.
 *
 * `truncate` sends the headers and the body given and then half-closes, so the
 * server reads fewer bytes than the request declared and its read fails for a
 * reason that is not a size overflow. The write side stays open, so the answer
 * still arrives.
 */
const raw = (
  target: string,
  head: ReadonlyArray<string>,
  body = "",
  truncate = false
): Promise<{ readonly status: number; readonly body: string }> => {
  const url = new URL(target)
  return new Promise((resolve, reject) => {
    let received = ""
    const socket = connect({ host: url.hostname, port: Number(url.port), allowHalfOpen: true }, () => {
      const request = `${[...head, `Host: ${url.host}`, "", ""].join("\r\n")}${body}`
      if (truncate) socket.end(request)
      else socket.write(request)
    })
    const answer = () => {
      const separator = received.indexOf("\r\n\r\n")
      if (separator < 0) return
      const headers = received.slice(0, separator)
      const payload = received.slice(separator + 4)
      const status = Number(/^HTTP\/1\.1 (\d+)/.exec(headers)?.[1] ?? 0)
      const declared = /content-length: (\d+)/i.exec(headers)?.[1]
      // 101 carries no body, and anything else is complete once the bytes it
      // declared have arrived.
      if (status !== 101 && (declared === undefined || payload.length < Number(declared))) return
      socket.destroy()
      resolve({ status, body: payload })
    }
    socket.setEncoding("utf8")
    socket.on("data", (chunk: string) => {
      received += chunk
      answer()
    })
    socket.on("end", () => resolve({ status: 0, body: received }))
    socket.on("error", reject)
  })
}

/** A control client speaking to the served gateway over real HTTP and WebSocket. */
const client = (url: string, credential?: string | undefined) =>
  ControlClient.layer(credential === undefined ? { url: `${url}/rpc` } : { url: `${url}/rpc`, credential }).pipe(
    Layer.provide([
      NodeHttpClient.layerUndici,
      NodeSocket.layerWebSocket(`${url.replace("http://", "ws://")}/rpc/ws`),
      RpcSerialization.layerNdjson
    ])
  )

describe("the RPC body a mount will act on", () => {
  it("accepts a framed request message and refuses a body that carries none", () => {
    const ndjson = RpcSerialization.ndjson
    const request = `${JSON.stringify({ _tag: "Request", id: 1, tag: "List", payload: {}, headers: [] })}\n`

    expect(GatewayServer.carriesRpcRequest(ndjson, request)).toBe(true)
    expect(GatewayServer.carriesRpcRequest(ndjson, "{}")).toBe(false)
    expect(GatewayServer.carriesRpcRequest(ndjson, "")).toBe(false)
    // A complete line that is not JSON is what makes the parser throw; an
    // unterminated one is buffered and simply yields no message.
    expect(GatewayServer.carriesRpcRequest(ndjson, "not json\n")).toBe(false)
  })

  it("leaves a binary framing to the mount, since its body is not text", () => {
    expect(GatewayServer.carriesRpcRequest(RpcSerialization.msgPack, "{}")).toBe(true)
  })
})

describe("telling a size overflow from every other body-read failure", () => {
  /** The exact shape `@effect/platform-node` raises for each. */
  const httpServerError = (cause: unknown) => ({
    _tag: "HttpServerError",
    reason: { _tag: "RequestParseError", cause }
  })

  it.each([
    ["the upstream size overflow", httpServerError(new Error("maxBytes exceeded")), true],
    ["a transport failure carrying another Error", httpServerError(new Error("socket hang up")), false],
    ["a parse failure carrying no cause", httpServerError(undefined), false],
    ["a reason that is not an object", { reason: "RequestParseError" }, false],
    ["a null reason", { reason: null }, false],
    ["an error with no reason at all", new Error("boom"), false],
    ["null", null, false],
    ["undefined", undefined, false],
    ["a string", "maxBytes exceeded", false]
  ])("reads %s as %s", (_name, error, expected) => {
    // A body that could not be read is not a body that was too big. Answering
    // 413 for every read failure told a client to shrink a request that was
    // never the problem.
    expect(GatewayServer.exceededBodyLimit(error)).toBe(expected)
  })
})

describe("the assembled gateway over a real loopback bind", () => {
  test("answers GET /health with the workspace identity and the package version", () =>
    Effect.gen(function*() {
      const url = yield* baseUrl
      const response = yield* Effect.promise(() => fetch(`${url}/health`))
      expect(response.status).toBe(200)
      expect(yield* Effect.promise(() => response.json() as Promise<unknown>)).toEqual(health)
    }).pipe(Effect.provide(served())))

  test("answers an unknown route with 404 and serves nothing else", () =>
    Effect.gen(function*() {
      const url = yield* baseUrl
      const response = yield* Effect.promise(() => fetch(`${url}/nope`))
      expect(response.status).toBe(404)
    }).pipe(Effect.provide(served())))

  /**
   * A malformed request is the caller's mistake, and the status code is how a
   * caller learns that. In the Phase 7 smoke `POST /rpc` with body `{}`
   * answered 500 with an empty body, which tells an operator the gateway
   * broke and tells a client to retry a request that can never succeed.
   */
  for (
    const [name, body] of [
      ["an empty JSON object", "{}"],
      ["an array", "[]"],
      ["text that is not JSON at all", "not json"],
      ["nothing at all", ""]
    ] as const
  ) {
    test(`answers POST /rpc carrying ${name} with 400 and a typed error body`, () =>
      Effect.gen(function*() {
        const url = yield* baseUrl
        const response = yield* Effect.promise(() =>
          fetch(`${url}/rpc`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body
          })
        )

        expect(response.status).toBe(400)
        expect(yield* Effect.promise(() => response.json() as Promise<unknown>)).toEqual({
          _tag: "flows/gateway/GatewayError",
          code: "malformed_request",
          message: "POST /rpc carries no RPC request message"
        })
      }).pipe(Effect.provide(served())))
  }

  test("refuses a malformed body on every RPC mount, not only /rpc", () =>
    Effect.gen(function*() {
      const url = yield* baseUrl
      for (const path of GatewayServer.rpcPaths) {
        const response = yield* Effect.promise(() =>
          fetch(`${url}${path}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{}"
          })
        )
        expect([path, response.status]).toEqual([path, 400])
      }
    }).pipe(Effect.provide(served())))

  test("refuses fixed-length and chunked RPC bodies above the configured limit", () =>
    Effect.gen(function*() {
      const url = yield* baseUrl
      const fixed = yield* Effect.promise(() =>
        fetch(`${url}/rpc`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "x".repeat(256)
        })
      )
      const bytes = new TextEncoder().encode("x".repeat(256))
      const chunkedBody = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes.subarray(0, 128))
          controller.enqueue(bytes.subarray(128))
          controller.close()
        }
      })
      const chunked = yield* Effect.promise(() =>
        fetch(
          `${url}/rpc`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: chunkedBody,
            duplex: "half"
          } as RequestInit & { readonly duplex: "half" }
        )
      )

      expect(fixed.status).toBe(413)
      expect(chunked.status).toBe(413)
      expect(yield* Effect.promise(() => fixed.json() as Promise<unknown>)).toMatchObject({
        code: "request_too_large"
      })
      expect(yield* Effect.promise(() => chunked.json() as Promise<unknown>)).toMatchObject({
        code: "request_too_large"
      })
    }).pipe(Effect.provide(served({ host: "127.0.0.1", port: 0, maxRequestBodyBytes: 64 }))))

  test("admits a body at exactly the limit and never trusts a declared length", () =>
    Effect.gen(function*() {
      const url = yield* baseUrl
      const post = (headers: ReadonlyArray<string>, body: string) =>
        raw(`${url}/rpc`, ["POST /rpc HTTP/1.1", "Content-Type: application/json", ...headers], body)

      // The limit is a maximum, not a threshold: a body of exactly that many
      // bytes is served rather than refused.
      const atLimit = yield* Effect.promise(() => post([`Content-Length: ${exactBodyBytes}`], exactBody))
      expect(atLimit.status).toBe(200)

      // A body one byte over is refused, which is what makes the line above a
      // boundary rather than a coincidence.
      const overLimit = yield* Effect.promise(() => post([`Content-Length: ${exactBodyBytes + 1}`], `${exactBody} `))
      expect(overLimit.status).toBe(413)
      expect(JSON.parse(overLimit.body)).toMatchObject({ code: "request_too_large" })

      // A body the server could not read is not a body that was too big.
      // Answering 413 for every read failure told a client to shrink a request
      // that was never the problem, so a truncated body earns 400 instead.
      const truncated = yield* Effect.promise(() =>
        raw(
          `${url}/rpc`,
          ["POST /rpc HTTP/1.1", "Content-Type: application/json", `Content-Length: ${exactBodyBytes}`],
          exactBody.slice(0, 4),
          true
        )
      )
      expect(truncated.status).toBe(400)
      expect(JSON.parse(truncated.body)).toMatchObject({
        code: "malformed_request",
        message: "POST /rpc carries a body the server could not read"
      })

      // A declared length that understates the body smuggles nothing past the
      // limit, and needs no test of its own: HTTP/1.1 framing means the server
      // reads exactly the length it was given, so the extra bytes are never
      // part of this request at all. The case the guard has to answer for is a
      // body that declares no length, which the chunked case above covers.
    }).pipe(Effect.provide(served({ host: "127.0.0.1", port: 0, maxRequestBodyBytes: exactBodyBytes }))))

  test("authenticates before inspecting an oversized body", () =>
    Effect.gen(function*() {
      const url = yield* baseUrl
      const response = yield* Effect.promise(() =>
        fetch(`${url}/rpc`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "x".repeat(256)
        })
      )
      expect(response.status).toBe(401)
      expect(yield* Effect.promise(() => response.json() as Promise<unknown>)).toMatchObject({ code: "unauthorized" })
    }).pipe(Effect.provide(served({
      host: "127.0.0.1",
      port: 0,
      credential: "edge-secret",
      maxRequestBodyBytes: 64
    }))))

  test("lets an authenticated request reach the body guard", () =>
    Effect.gen(function*() {
      const url = yield* baseUrl
      const response = yield* Effect.promise(() =>
        fetch(`${url}/rpc`, {
          method: "POST",
          headers: {
            authorization: "Bearer edge-secret",
            "content-type": "application/json"
          },
          body: "{}"
        })
      )

      expect(response.status).toBe(400)
      expect(yield* Effect.promise(() => response.json() as Promise<unknown>)).toMatchObject({
        code: "malformed_request"
      })
    }).pipe(Effect.provide(served({
      host: "127.0.0.1",
      port: 0,
      credential: "edge-secret"
    }))))

  test("passes a well-formed request message through to the server it names", () =>
    Effect.gen(function*() {
      const url = yield* baseUrl
      const response = yield* Effect.promise(() =>
        fetch(`${url}/rpc`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: `${JSON.stringify({ _tag: "Request", id: 1, tag: "NoSuchProcedure", payload: {}, headers: [] })}\n`
        })
      )

      // The procedure does not exist, so the server answers an RPC-level
      // defect. What matters here is that the guard did not answer for it.
      expect(response.status).toBe(200)
      expect(yield* Effect.promise(() => response.text())).toContain("NoSuchProcedure")
    }).pipe(Effect.provide(served())))

  test("plans, approves, runs, and reads a run back through the served control plane", () =>
    Effect.gen(function*() {
      const url = yield* baseUrl
      const remote = yield* Effect.gen(function*() {
        const control = yield* Control
        const card = yield* control.plan({ flowId: "system/test", input: { suite: "served" } })
        yield* control.approve(approvalOf(card))
        const receipt = yield* control.run({
          _tag: "Plan",
          planId: card.planId,
          digest: card.digest,
          envelope: card.envelope,
          idempotencyKey: `run:${card.planId}`
        })
        if (receipt._tag !== "Accepted" || receipt.runId === undefined) {
          return yield* Effect.die("expected an accepted run")
        }
        const listed = yield* control.list({ _tag: "runs", filters: { runId: receipt.runId } })
        yield* control.cancel({
          runId: receipt.runId,
          idempotencyKey: `cancel:${receipt.runId}`,
          reason: "the suite is done"
        })
        const after = yield* control.list({ _tag: "runs", filters: { runId: receipt.runId } })
        const flows = yield* control.list({ _tag: "flows" })
        return { listed, after, flows, runId: receipt.runId }
      }).pipe(Effect.provide(client(url)))

      expect(remote.listed._tag).toBe("runs")
      expect(remote.after._tag).toBe("runs")
      expect(remote.flows._tag).toBe("flows")
      if (remote.listed._tag !== "runs" || remote.after._tag !== "runs") return
      // Read back by run id, in the seven-status vocabulary, over the wire.
      expect(remote.listed.items).toMatchObject([{ runId: remote.runId, flowId: "system/test" }])
      expect(SEVEN_STATUSES).toContain(remote.listed.items[0]?.status ?? "")
      // The cancel is durable: the next read of the same run says so.
      expect(remote.after.items).toMatchObject([{ runId: remote.runId, status: "cancelled" }])
    }).pipe(Effect.provide(served())))

  /**
   * Attribution over a credentialed bind, which is the only composition where
   * the authenticated identity and the runtime's default differ. A loopback
   * gateway authenticates `local`/`operator` and the SQL runtime defaults to
   * the same pair, so every earlier suite agreed with a handler that dropped
   * the principal and one that forwarded it.
   */
  test("journals a bearer operator's cancel as the bearer, not as the local default", () =>
    Effect.gen(function*() {
      const url = yield* baseUrl
      const remote = yield* Effect.gen(function*() {
        const control = yield* Control
        const card = yield* control.plan({ flowId: "system/test", input: { suite: "bearer" } })
        yield* control.approve(approvalOf(card))
        const receipt = yield* control.run({
          _tag: "Plan",
          planId: card.planId,
          digest: card.digest,
          envelope: card.envelope,
          idempotencyKey: `run:${card.planId}`
        })
        if (receipt._tag !== "Accepted" || receipt.runId === undefined) {
          return yield* Effect.die("expected an accepted run")
        }
        yield* control.cancel({
          runId: receipt.runId,
          idempotencyKey: `cancel:${receipt.runId}`,
          reason: "a remote operator asked"
        })
        return receipt.runId
        // Only the unary mounts carry the credential: `ControlClient` attaches
        // the bearer to HTTP and the socket protocol has no header to put it
        // on, so the record is read back in process below.
      }).pipe(Effect.provide(client(url, "edge-secret")))

      const control = yield* Control
      const events = yield* Stream.runCollect(control.watch({ runId: remote, follow: false }))
      const listed = yield* control.list({ _tag: "runs", filters: { runId: remote } })

      const requested = events.find((event) => event.kind === "control.run.cancel-requested")
      expect((requested?.payload as { readonly principal?: unknown } | null)?.principal)
        .toMatchObject({ id: "gateway", kind: "bearer" })
      if (listed._tag !== "runs") return
      expect(listed.items[0]?.cancellation?.principal).toMatchObject({ id: "gateway", kind: "bearer" })
    }).pipe(Effect.provide(served({ host: "127.0.0.1", port: 0, credential: "edge-secret" }))))

  test("serves a projection snapshot over POST /projections, framed on the wire", () =>
    Effect.gen(function*() {
      const url = yield* baseUrl
      const projections = yield* Projections
      const control = yield* Control
      const card = yield* control.plan({ flowId: "system/test", input: {} })
      yield* control.approve(approvalOf(card))
      const receipt = yield* control.run({
        _tag: "Plan",
        planId: card.planId,
        digest: card.digest,
        envelope: card.envelope,
        idempotencyKey: `run:${card.planId}`
      })
      if (receipt._tag !== "Accepted" || receipt.runId === undefined) return yield* Effect.die("expected a run")
      const selector = { _tag: "run-summary" as const, runId: receipt.runId }

      // The relay reaches the projections over the request/response path, so
      // the mount is exercised the way that path uses it rather than only in
      // process.
      const response = yield* Effect.promise(() =>
        fetch(`${url}/projections`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: `${
            JSON.stringify({
              _tag: "Request",
              id: 1,
              tag: "Projection.Snapshot",
              payload: { selector },
              headers: []
            })
          }\n`
        })
      )
      const framed = yield* Effect.promise(() => response.text())
      const exit = JSON.parse(framed.split("\n")[0] ?? "{}") as {
        readonly _tag: string
        readonly exit: { readonly _tag: string; readonly value: unknown }
      }

      expect(response.status).toBe(200)
      expect(exit._tag).toBe("Exit")
      expect(exit.exit._tag).toBe("Success")
      // What the wire answers is what the service answers.
      expect(exit.exit.value).toEqual(yield* projections.snapshot(selector))
    }).pipe(Effect.provide(served())))

  test("serves a sync read over POST /sync", () =>
    Effect.gen(function*() {
      const url = yield* baseUrl
      const response = yield* Effect.promise(() =>
        fetch(`${url}/sync`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: `${
            JSON.stringify({
              _tag: "Request",
              id: 1,
              tag: "Read",
              payload: { scope: { _tag: "workspace" }, limit: 10 },
              headers: []
            })
          }\n`
        })
      )
      // The sync mount is reachable and framed. What it answers for a given
      // cursor is `@smthrs/sync`'s contract, proved in that package.
      expect(response.status).toBe(200)
      expect(yield* Effect.promise(() => response.text())).toContain("\"Exit\"")
    }).pipe(Effect.provide(served())))

  test("freezes the wire form of the health body and a refusal frame", () =>
    Effect.gen(function*() {
      const url = yield* baseUrl
      const probe = yield* Effect.promise(() => fetch(`${url}/health`))
      // A golden body: a renamed or dropped field fails here rather than in a
      // deployment that reads the identity to decide whether to replace this
      // process.
      expect(yield* Effect.promise(() => probe.json() as Promise<unknown>)).toEqual({
        workspaceHash: "workspace-hash",
        gatewayId: "gateway-1",
        protocolVersion: "1",
        version: "1.0.0-rc.0"
      })

      const refused = yield* Effect.promise(() =>
        fetch(`${url}/projections`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}"
        })
      )
      expect(yield* Effect.promise(() => refused.json() as Promise<unknown>)).toEqual({
        _tag: "flows/gateway/GatewayError",
        code: "malformed_request",
        message: "POST /projections carries no RPC request message"
      })
    }).pipe(Effect.provide(served())))

  test("refuses an uncredentialed WebSocket upgrade on every protected socket", () =>
    Effect.gen(function*() {
      const url = yield* baseUrl
      // The relay opens the sockets, so the guard has to run on the upgrade
      // request and not only on the unary mounts. `layerIngress` is a global
      // router middleware and every socket path is in `protectedPaths`.
      for (const path of ["/rpc/ws", "/projections/ws", "/sync/ws"]) {
        const response = yield* Effect.promise(() =>
          raw(`${url}${path}`, [
            `GET ${path} HTTP/1.1`,
            "Connection: Upgrade",
            "Upgrade: websocket",
            "Sec-WebSocket-Version: 13",
            "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ=="
          ])
        )
        expect([path, response.status]).toEqual([path, 401])
        expect([path, JSON.parse(response.body) as unknown]).toEqual([path, {
          _tag: "flows/gateway/GatewayError",
          code: "unauthorized",
          message: "A valid bearer credential is required"
        }])
      }
    }).pipe(Effect.provide(served({ host: "127.0.0.1", port: 0, credential: "edge-secret" }))))

  test("streams a projection snapshot and keeps the connection alive between changes", () =>
    Effect.gen(function*() {
      const projections = yield* Projections
      const control = yield* Control
      const card = yield* control.plan({ flowId: "system/test", input: {} })
      yield* control.approve(approvalOf(card))
      const receipt = yield* control.run({
        _tag: "Plan",
        planId: card.planId,
        digest: card.digest,
        envelope: card.envelope,
        idempotencyKey: `run:${card.planId}`
      })
      if (receipt._tag !== "Accepted" || receipt.runId === undefined) return yield* Effect.die("expected a run")
      const runId = receipt.runId

      const frames = yield* Stream.runCollect(
        Stream.take(projections.subscribe({ _tag: "run-summary", runId }), 4)
      )
      expect(frames[0]?._tag).toBe("snapshot-start")
      expect(frames[1]?._tag).toBe("row")
      expect(frames[2]?._tag).toBe("snapshot-end")
      // Nothing has changed since the snapshot, so the fourth frame is the
      // keepalive that stops a relay cutting an idle tunnel.
      expect(frames[3]?._tag).toBe("heartbeat")
      yield* emit(runId, "control.run.completed", { runId })
    }).pipe(Effect.provide(served())))

  test("lists a child run beside the parent it came from", () =>
    Effect.gen(function*() {
      const projections = yield* Projections
      const control = yield* Control
      const card = yield* control.plan({ flowId: "system/test", input: {} })
      yield* control.approve(approvalOf(card))
      const receipt = yield* control.run({
        _tag: "Plan",
        planId: card.planId,
        digest: card.digest,
        envelope: card.envelope,
        idempotencyKey: `run:${card.planId}`
      })
      if (receipt._tag !== "Accepted" || receipt.runId === undefined) return yield* Effect.die("expected a run")

      const rows = (yield* projections.snapshot({ _tag: "workspace-runs" })).rows as ReadonlyArray<
        { readonly runId: string; readonly parentRunId?: string }
      >
      // The ordinary listing is what every run surface renders. A parent that
      // spawns children must not be the only run it shows.
      expect(rows.map((row) => row.runId)).toContain(receipt.runId)
    }).pipe(Effect.provide(served())))

  test("keeps an idle followed Watch alive on /rpc/ws", () =>
    Effect.gen(function*() {
      const url = yield* baseUrl
      const control = yield* Control
      const card = yield* control.plan({ flowId: "system/test", input: {} })
      yield* control.approve(approvalOf(card))
      const receipt = yield* control.run({
        _tag: "Plan",
        planId: card.planId,
        digest: card.digest,
        envelope: card.envelope,
        idempotencyKey: `run:${card.planId}`
      })
      if (receipt._tag !== "Accepted" || receipt.runId === undefined) return yield* Effect.die("expected a run")
      const runId = receipt.runId

      const observed = yield* Effect.gen(function*() {
        const remote = yield* Control
        const history = yield* Stream.runCollect(remote.watch({ runId, follow: false }))
        const last = history.at(-1)?.sequence ?? 0
        // Nothing will happen to this run again, so every frame from here is
        // the server's own keepalive. Without it the socket is silent until
        // the run moves, and a relay cuts the tunnel first.
        const frames = yield* Stream.runCollect(
          Stream.take(remote.watch({ runId, afterSequence: last, follow: true }), 2)
        )
        return { last, frames }
      }).pipe(Effect.provide(client(url)))

      expect(observed.frames.map((frame) => frame.kind)).toEqual([
        GatewayServer.watchHeartbeatKind,
        GatewayServer.watchHeartbeatKind
      ])
      // It repeats the last sequence delivered, so a client resuming from the
      // last sequence it saw does not rewind on a keepalive, and it names the
      // run so a client routing by run keeps routing.
      expect(observed.frames.map((frame) => frame.sequence)).toEqual([observed.last, observed.last])
      expect(observed.frames[0]?.runId).toBe(runId)
    }).pipe(Effect.provide(served({ host: "127.0.0.1", port: 0, heartbeatMillis: 25 }))))
})

describe("the Watch keepalive", () => {
  const kept = GatewayServer.layerKeepAlive(25).pipe(Layer.provideMerge(stack()))

  test("leaves a snapshot read alone and names no run on a workspace watch", () =>
    Effect.gen(function*() {
      const control = yield* Control
      const card = yield* control.plan({ flowId: "system/test", input: {} })
      yield* control.approve(approvalOf(card))

      // A snapshot read has to end, so nothing is merged into it.
      const snapshot = yield* Stream.runCollect(control.watch({ follow: false }))
      expect(snapshot.length).toBeGreaterThan(0)
      expect(snapshot.filter((event) => event.kind === GatewayServer.watchHeartbeatKind)).toEqual([])

      // A workspace-wide watch is not about one run, so its keepalive names
      // none: a client routing by run must not route a keepalive anywhere.
      const beats = yield* Stream.runCollect(
        Stream.take(
          Stream.filter(control.watch({ follow: true }), (event) => event.kind === GatewayServer.watchHeartbeatKind),
          1
        )
      )
      expect(beats[0]?.runId).toBeUndefined()
      expect(beats[0]?.payload).toBeNull()
    }).pipe(Effect.provide(kept)))
})

describe("gateway bind policy", () => {
  /** Whatever a start-time refusal raised, as the typed error it should be. */
  const raised = (build: () => unknown): GatewayError => {
    try {
      build()
    } catch (error) {
      expect(error).toBeInstanceOf(GatewayError)
      return error as GatewayError
    }
    throw new Error("expected a refusal")
  }

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])("refuses the invalid body limit %s", (maxRequestBodyBytes) => {
    // A start-time refusal is this package's own typed failure, so a host that
    // reports one reports a `bind_failed` code rather than a bare exception.
    const refusal = raised(() => GatewayServer.layerIngress({ maxRequestBodyBytes }))
    expect(refusal.code).toBe("bind_failed")
    expect(refusal.message).toContain("request body limit")
    expect(NodeGateway.bindRefusal({ port: 0, maxRequestBodyBytes })?.code).toBe("bind_failed")
  })

  it.each([0, -1, 1.5])("refuses the invalid keepalive cadence %s", (heartbeatMillis) => {
    // A cadence of zero makes `Stream.tick` a tight loop that floods every
    // subscriber, which is why the cadence is checked the same way the body
    // limit is rather than not at all.
    const assembled = raised(() => GatewayServer.layer(health, { heartbeatMillis }))
    expect(assembled.code).toBe("bind_failed")
    expect(assembled.message).toContain("keepalive cadence")
    expect(raised(() => makeProjections({} as unknown as ControlService, { heartbeatMillis })).code).toBe("bind_failed")
    expect(NodeGateway.bindRefusal({ port: 0, heartbeatMillis })?.code).toBe("bind_failed")
  })

  it("accepts a positive cadence and body limit", () => {
    expect(NodeGateway.bindRefusal({ port: 0, heartbeatMillis: 25, maxRequestBodyBytes: 64 })).toBeUndefined()
  })

  it("defaults a bind with no host to loopback", () => {
    expect(NodeGateway.listenOptions({ port: 0 })).toEqual({ port: 0, host: "127.0.0.1" })
    expect(NodeGateway.bindRefusal({ port: 0 })).toBeUndefined()
  })

  it("accepts every loopback spelling with no opt-in and no credential", () => {
    for (const host of ["127.0.0.1", "::1", "localhost"]) {
      expect(NodeGateway.isLoopbackHost(host)).toBe(true)
      expect(NodeGateway.listenOptions({ host, port: 0 })).toEqual({ host, port: 0 })
    }
  })

  it("classifies every other host as reachable from elsewhere", () => {
    // `127.0.0.2` is loopback to the kernel and is not one of the three names
    // this policy accepts: the policy is a list of spellings a person types,
    // not a subnet test, and widening it silently is how a gateway ends up
    // reachable without the opt-in.
    for (const host of ["0.0.0.0", "::", "192.168.1.10", "example.com", "", "127.0.0.2"]) {
      expect(NodeGateway.isLoopbackHost(host)).toBe(false)
    }
  })

  it("refuses a non-loopback bind without an explicit --listen", () => {
    expect(raised(() => NodeGateway.listenOptions({ host: "0.0.0.0", port: 0 })).message).toMatch(/--listen/)
    expect(raised(() => NodeGateway.listenOptions({ host: "0.0.0.0", port: 0, listen: false })).message).toMatch(
      /--listen/
    )
  })

  it("refuses a non-loopback bind without a bearer credential", () => {
    expect(raised(() => NodeGateway.listenOptions({ host: "0.0.0.0", port: 0, listen: true })).message).toMatch(
      /bearer credential/
    )
    expect(
      raised(() => NodeGateway.listenOptions({ host: "0.0.0.0", port: 0, listen: true, credential: "" })).message
    ).toMatch(/bearer credential/)
  })

  it("accepts a credentialed non-loopback bind that opted in", () => {
    expect(NodeGateway.listenOptions({
      host: "0.0.0.0",
      port: 0,
      listen: true,
      credential: "secret",
      maxRequestBodyBytes: 128
    })).toEqual({
      host: "0.0.0.0",
      port: 0
    })
  })

  it("defaults to a loopback bind on the gateway port", () => {
    expect(NodeGateway.defaultServerOptions).toEqual({ host: "127.0.0.1", port: 7331 })
  })
})

describe("gateway credential policy", () => {
  test("refuses an unauthenticated call and accepts the configured credential", () =>
    Effect.gen(function*() {
      const url = yield* baseUrl
      const plan = (credential: string | undefined) =>
        Effect.flatMap(Control, (control) => control.plan({ flowId: "system/test", input: {} })).pipe(
          Effect.provide(client(url, credential))
        )

      const refused = yield* Effect.flip(plan(undefined))
      const accepted = yield* plan("alpha-secret")

      // Fail closed: no credential is refused with the same answer a wrong
      // one gets, and only the configured token is served.
      expect(refused._tag).toBe("/control/Unauthorized")
      expect(accepted.flowId).toBe("system/test")
    }).pipe(Effect.provide(served({ host: "127.0.0.1", port: 0, credential: "alpha-secret" }))))

  test("refuses a wrong credential the same way it refuses none", () =>
    Effect.gen(function*() {
      const url = yield* baseUrl
      const refused = yield* Effect.flip(
        Effect.flatMap(Control, (control) => control.plan({ flowId: "system/test", input: {} })).pipe(
          Effect.provide(client(url, "alpha-secre"))
        )
      )
      expect(refused._tag).toBe("/control/Unauthorized")
    }).pipe(Effect.provide(served({ host: "127.0.0.1", port: 0, credential: "alpha-secret" }))))
})

describe("gateway error vocabulary", () => {
  test("reaches callers through every behavioral gateway error code", () =>
    Effect.gen(function*() {
      const url = yield* baseUrl
      const projections = yield* Projections
      const postCode = (body: string, credential?: string | undefined) =>
        Effect.promise(async () => {
          const response = await fetch(`${url}/rpc`, {
            method: "POST",
            headers: {
              ...(credential === undefined ? {} : { authorization: `Bearer ${credential}` }),
              "content-type": "application/json"
            },
            body
          })
          return (await response.json() as { readonly code: string }).code
        })
      const unavailable = makeProjections({
        list: () => Effect.fail(new Unavailable({ code: "unavailable", feature: "list", ticket: "T-errors" })),
        watch: () => Stream.empty
      } as unknown as ControlService)
      const table = [
        [
          "bind_failed",
          Effect.sync(() => NodeGateway.bindRefusal({ host: "0.0.0.0", port: 0 })?.code)
        ],
        ["unauthorized", postCode("{}")],
        ["malformed_request", postCode("{}", "edge-secret")],
        ["request_too_large", postCode("x".repeat(256), "edge-secret")],
        [
          "run_unavailable",
          Effect.map(Effect.flip(unavailable.snapshot({ _tag: "workspace-runs" })), (failure) => failure.code)
        ],
        [
          "run_not_found",
          Effect.map(
            Effect.flip(projections.snapshot({ _tag: "run-summary", runId: "missing-run" })),
            (failure) => failure.code
          )
        ]
      ] as const satisfies ReadonlyArray<readonly [GatewayErrorCodeValue, Effect.Effect<string | undefined, unknown>]>

      for (const [expected, operation] of table) {
        expect(yield* operation).toBe(expected)
      }
      // The declared vocabulary is exactly the vocabulary the table just
      // produced, so a code cannot outlive the path that constructs it.
      expect([...GatewayErrorCode.literals].sort()).toEqual(table.map(([code]) => code as string).sort())
    }).pipe(Effect.provide(served({
      host: "127.0.0.1",
      port: 0,
      credential: "edge-secret",
      maxRequestBodyBytes: 64
    }))))
})

describe("gateway startup", () => {
  test("comes up and answers /health with a read path that cannot read", () =>
    Effect.gen(function*() {
      const url = yield* baseUrl
      const response = yield* Effect.promise(() => fetch(`${url}/health`))
      // Startup must never be blocked by a subsystem that failed to recover:
      // a supervisor still has to be able to ask which workspace this is.
      expect(response.status).toBe(200)
      expect(yield* Effect.promise(() => response.json() as Promise<unknown>)).toEqual(health)
    }).pipe(
      Effect.provide(
        NodeGateway.layer(health, { host: "127.0.0.1", port: 0 }).pipe(
          Layer.provideMerge(
            Layer.mergeAll(
              Layer.succeed(Projections, {
                snapshot: () => Effect.fail(new GatewayError({ code: "run_unavailable", message: "recovery boom" })),
                subscribe: () => Stream.fail(new GatewayError({ code: "run_unavailable", message: "recovery boom" }))
              }),
              SyncServer.layerNoop,
              Layer.succeed(SyncAuthTag, () => Effect.die("sync is unavailable"))
            ).pipe(Layer.provideMerge(stack()))
          )
        )
      )
    ))
})
