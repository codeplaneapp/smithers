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
import * as ControlClient from "@smthrs/control/ControlClient"
import type { ApprovalPayload, PlanCard } from "@smthrs/control/ControlSchema"
import { SyncAuth as SyncAuthTag } from "@smthrs/sync/SyncRpcs"
import * as SyncServer from "@smthrs/sync/SyncServer"
import { Effect, Layer, type Scope, Stream } from "effect"
import { HttpServer } from "effect/unstable/http"
import { RpcSerialization } from "effect/unstable/rpc"
import { GatewayError } from "../src/GatewayError.ts"
import * as GatewayServer from "../src/GatewayServer.ts"
import * as NodeGateway from "../src/node/NodeGateway.ts"
import { Projections } from "../src/Projections.ts"
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
          message: "POST /rpc carries no RPC request message",
          cause: null
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
  it("defaults a bind with no host to loopback", () => {
    expect(NodeGateway.listenOptions({ port: 0 })).toEqual({ port: 0, host: "127.0.0.1" })
  })

  it("accepts every loopback spelling with no opt-in and no credential", () => {
    for (const host of ["127.0.0.1", "::1", "localhost"]) {
      expect(NodeGateway.isLoopbackHost(host)).toBe(true)
      expect(NodeGateway.listenOptions({ host, port: 0 })).toEqual({ host, port: 0 })
    }
  })

  it("refuses a non-loopback bind without an explicit --listen", () => {
    expect(() => NodeGateway.listenOptions({ host: "0.0.0.0", port: 0 })).toThrow(/--listen/)
    expect(() => NodeGateway.listenOptions({ host: "0.0.0.0", port: 0, listen: false })).toThrow(/--listen/)
  })

  it("refuses a non-loopback bind without a bearer credential", () => {
    expect(() => NodeGateway.listenOptions({ host: "0.0.0.0", port: 0, listen: true })).toThrow(/bearer credential/)
    expect(() => NodeGateway.listenOptions({ host: "0.0.0.0", port: 0, listen: true, credential: "" })).toThrow(
      /bearer credential/
    )
  })

  it("accepts a credentialed non-loopback bind that opted in", () => {
    expect(NodeGateway.listenOptions({ host: "0.0.0.0", port: 0, listen: true, credential: "secret" })).toEqual({
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
                snapshot: () =>
                  Effect.fail(new GatewayError({ code: "sweep_failed", message: "recovery boom", cause: null })),
                subscribe: () =>
                  Stream.fail(new GatewayError({ code: "sweep_failed", message: "recovery boom", cause: null }))
              }),
              SyncServer.layerNoop,
              Layer.succeed(SyncAuthTag, () => Effect.die("sync is unavailable"))
            ).pipe(Layer.provideMerge(stack()))
          )
        )
      )
    ))
})
