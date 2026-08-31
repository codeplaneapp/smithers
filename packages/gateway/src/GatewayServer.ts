/**
 * The assembled workspace gateway: one HTTP surface carrying the control
 * plane, the sync read path, the served projections, and a health probe.
 *
 * Mounts:
 *
 * | Path | Protocol | Serves |
 * | --- | --- | --- |
 * | `POST /rpc` | RPC over HTTP | `@smthrs/control` `ControlRpcs` |
 * | `/rpc/ws` | RPC over WebSocket | `ControlRpcs`, including a kept-alive `Watch` |
 * | `POST /projections` | RPC over HTTP | `GatewayRpcs` |
 * | `/projections/ws` | RPC over WebSocket | `GatewayRpcs`, including `Projection.Subscribe` |
 * | `POST /sync` | RPC over HTTP | `@smthrs/sync` `SyncRpcs` |
 * | `/sync/ws` | RPC over WebSocket | `SyncRpcs` |
 * | `GET /health` | JSON | `GatewaySchema.GatewayHealth` plus the package version |
 *
 * `/health` is deliberately unauthenticated: a supervisor decides whether to
 * keep or replace a gateway process by asking which workspace it belongs to,
 * and a probe that needed a credential could not answer that question about a
 * gateway it did not start. The response carries identity only: the
 * workspace hash, the gateway id, the protocol version, and the package
 * version. It never carries a token, a run, or a path.
 *
 * @since 1.0.0
 */
import { Control } from "@smthrs/control/Control"
import type * as ControlError from "@smthrs/control/ControlError"
import type * as ControlSchema from "@smthrs/control/ControlSchema"
import * as ControlServer from "@smthrs/control/ControlServer"
import { SyncRpcs } from "@smthrs/sync/SyncRpcs"
import * as SyncServer from "@smthrs/sync/SyncServer"
import { Effect, Layer, Schema, Stream, type Types } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { RpcSerialization, RpcServer } from "effect/unstable/rpc"
import { GatewayError } from "./GatewayError.ts"
import { GatewayRpcs } from "./GatewayRpcs.ts"
import * as GatewaySchema from "./GatewaySchema.ts"
import { heartbeatIntervalMillis, Projections } from "./Projections.ts"

/**
 * What `GET /health` answers: the `GatewaySchema.GatewayHealth` identity plus
 * the version of the package serving it.
 *
 * @since 1.0.0
 * @category models
 */
export const Health = Schema.Struct({
  ...GatewaySchema.GatewayHealth.fields,
  version: Schema.String
})

/**
 * What `GET /health` answers.
 *
 * @since 1.0.0
 * @category models
 */
export type Health = typeof Health.Type

const encodeHealth = Schema.encodeUnknownSync(Health)

/**
 * Mounts the unauthenticated health probe.
 *
 * @param health the identity this process serves under
 * @since 1.0.0
 * @category layers
 */
export const layerHealth = (health: Health): Layer.Layer<never, never, HttpRouter.HttpRouter> =>
  HttpRouter.add("GET", "/health", HttpServerResponse.jsonUnsafe(encodeHealth(health)))

/**
 * The gateway's own RPC handlers over the read path and the control plane.
 *
 * @since 1.0.0
 * @category layers
 */
export const layerHandlers = GatewayRpcs.toLayer(
  Effect.gen(function*() {
    const projections = yield* Projections
    const control = yield* Control
    return GatewayRpcs.of({
      "Projection.Snapshot": Effect.fn("Gateway.snapshot")(({ selector }) => projections.snapshot(selector)),
      "Projection.Subscribe": ({ selector }) => projections.subscribe(selector),
      /*
       * One operator act, two control mutations, one round trip. A parked
       * node's approval installs the grant; the run it parked still has to be
       * told to go on. Splitting those across the relay would leave a run
       * approved and stopped whenever the second call was lost.
       *
       * A denial issues no resume: the run stays parked, which is what a
       * denial means. A plan-scoped decision has no run to resume.
       */
      "Approval.Submit": Effect.fn("Gateway.submitApproval")((input) =>
        Effect.gen(function*() {
          const target = input.target
          const payload = { target, scope: input.scope, idempotencyKey: input.idempotencyKey }
          const decision = input.decision === "approve"
            ? yield* control.approve(payload)
            : yield* control.deny(payload)
          const resume = input.decision === "approve" && target._tag === "Node"
            ? yield* control.resume({
              runId: target.runId,
              idempotencyKey: `${input.idempotencyKey}:resume`
            })
            : undefined
          return resume === undefined ? { decision } : { decision, resume }
        })
      )
    })
  })
)

/**
 * The kind a `Watch` keepalive carries.
 *
 * `ControlRpcs.Watch` answers `ControlSchema.ControlEvent` and has no frame of
 * its own for a keepalive, so the gateway publishes one as an event whose kind
 * no emitter uses. A fold that does not know the kind ignores it, which is
 * what every fold in this package and in `@smthrs/cli` `Forensics` already
 * does with an unknown kind.
 *
 * @since 1.0.0
 * @category models
 */
export const watchHeartbeatKind = "control.gateway.heartbeat"

/**
 * Merges a keepalive into a followed `Watch` stream.
 *
 * A followed stream is silent while a run is thinking, and a relay cuts an
 * idle tunnel at 600 s (plue-consumer-contract §11). The Effect RPC client
 * sends its own `Ping` every 5 s, but a non-Effect consumer behind a relay
 * sends nothing, so the keepalive has to come from the server.
 *
 * The keepalive repeats the sequence of the last event delivered, so a client
 * that resumes from the last sequence it saw does not rewind on a heartbeat,
 * and it carries the watched run id so a client routing by run keeps routing.
 * A snapshot read (`follow: false`) is left alone: it has to end.
 */
const keptAlive = (
  millis: number,
  filter: ControlSchema.WatchFilter,
  events: Stream.Stream<ControlSchema.ControlEvent, ControlError.ControlError>
): Stream.Stream<ControlSchema.ControlEvent, ControlError.ControlError> => {
  if (filter.follow === false) return events
  let sequence = filter.afterSequence ?? 0
  const tracked = Stream.map(events, (event) => {
    sequence = event.sequence
    return event
  })
  const beats = Stream.tick(millis).pipe(
    Stream.drop(1),
    Stream.mapEffect(() =>
      Effect.map(
        Effect.clockWith((clock) => clock.currentTimeMillis),
        (occurredAt): ControlSchema.ControlEvent => ({
          sequence,
          kind: watchHeartbeatKind,
          ...(filter.runId === undefined ? {} : { runId: filter.runId }),
          occurredAt,
          payload: null
        })
      )
    )
  )
  return Stream.merge(tracked, beats, { haltStrategy: "left" })
}

/**
 * The control service the `/rpc` mounts read through: the ambient one, with
 * the keepalive merged into `watch`.
 *
 * Wrapping the service rather than re-declaring the handlers keeps
 * `@smthrs/control` `ControlServer` the single definition of what every
 * procedure does, principal stamping on `Approve` and `Deny` included. Only
 * `watch` behaves differently, and only in what it adds.
 *
 * @since 1.0.0
 * @category layers
 */
export const layerKeepAlive = (
  millis: number = heartbeatIntervalMillis
): Layer.Layer<Control, never, Control> =>
  Layer.effect(Control)(
    Effect.map(Control, (control) =>
      Control.of({ ...control, watch: (filter) => keptAlive(millis, filter, control.watch(filter)) }))
  )

/**
 * Mounts the control plane on `POST /rpc` and `/rpc/ws`, with the keepalive.
 *
 * @param millis how often an idle followed watch emits one, defaulting to
 * `Projections.heartbeatIntervalMillis`
 * @since 1.0.0
 * @category layers
 */
export const layerControlHttp = (millis?: number | undefined) =>
  ControlServer.layerHttp.pipe(Layer.provide(layerKeepAlive(millis)))

const gateway = RpcServer.layer(GatewayRpcs, { disableFatalDefects: true })

const sync = RpcServer.layer(SyncRpcs, { disableFatalDefects: true })

/**
 * Mounts the gateway's projections on `POST /projections` and
 * `/projections/ws`.
 *
 * Both protocols are mounted together because a client reads a snapshot over
 * the request/response path and follows deltas over the socket, and pointing
 * those at two different servers would let them disagree.
 *
 * @since 1.0.0
 * @category layers
 */
export const layerProjectionsHttp = Layer.mergeAll(
  gateway.pipe(
    Layer.provide(layerHandlers),
    Layer.provideMerge(RpcServer.layerProtocolHttp({ path: "/projections" })),
    Layer.fresh
  ),
  gateway.pipe(
    Layer.provide(layerHandlers),
    Layer.provideMerge(RpcServer.layerProtocolWebsocket({ path: "/projections/ws" })),
    Layer.fresh
  )
)

/**
 * Mounts the sync read path on `POST /sync` and `/sync/ws`.
 *
 * @since 1.0.0
 * @category layers
 */
export const layerSyncHttp = Layer.mergeAll(
  sync.pipe(
    Layer.provide(SyncServer.layerHandlers),
    Layer.provideMerge(RpcServer.layerProtocolHttp({ path: "/sync" })),
    Layer.fresh
  ),
  sync.pipe(
    Layer.provide(SyncServer.layerHandlers),
    Layer.provideMerge(RpcServer.layerProtocolWebsocket({ path: "/sync/ws" })),
    Layer.fresh
  )
)

/**
 * The POST mounts that carry RPC request messages and nothing else.
 *
 * @since 1.0.0
 * @category constants
 */
export const rpcPaths: ReadonlyArray<string> = ["/rpc", "/projections", "/sync"]

const encodeGatewayError = Schema.encodeUnknownSync(GatewayError)

const malformedRequest = (path: string) =>
  HttpServerResponse.jsonUnsafe(
    encodeGatewayError(
      new GatewayError({
        code: "malformed_request",
        message: `POST ${path} carries no RPC request message`,
        cause: null
      })
    ),
    { status: 400 }
  )

/**
 * Whether a request body carries at least one RPC message the server can act
 * on.
 *
 * The transport's own parser answers, not a second reading of the wire
 * format: whatever `RpcSerialization` the host composed decodes the body, and
 * the answer is no only when that decode throws or yields no tagged message.
 * A body naming a procedure that does not exist is a yes — that is an
 * RPC-level defect the protocol itself reports.
 *
 * A binary framing is always a yes. Its body is not text, so there is nothing
 * to read here, and the mount owns it.
 *
 * @since 1.0.0
 * @category predicates
 */
export const carriesRpcRequest = (
  serialization: RpcSerialization.RpcSerialization["Service"],
  body: string
): boolean => {
  if (!serialization.contentType.includes("json")) return true
  try {
    const decoded = serialization.makeUnsafe().decode(body)
    return decoded.length > 0 && decoded.every((message: unknown) =>
      typeof message === "object" && message !== null &&
      typeof (message as { readonly _tag?: unknown })._tag === "string"
    )
  } catch {
    return false
  }
}

/**
 * Refuses a body that carries no RPC request message with 400.
 *
 * `effect/unstable/rpc` hands every decoded message to the server loop, and a
 * body that decodes to something else — `{}`, `[]`, prose, nothing at all —
 * reached it as a message with no tag and died there, so the gateway answered
 * `500 Internal Server Error` with an empty body (Phase 7 smoke). That is the
 * wrong half of the contract twice over: it tells an operator the gateway
 * broke, and it tells a client to retry a request that can never succeed.
 *
 * `HttpServerRequest.text` is cached per request, so reading the body here
 * does not consume the body the mount reads.
 *
 * @since 1.0.0
 * @category layers
 */
export const layerRefuseMalformedRpc = HttpRouter.middleware(
  Effect.gen(function*() {
    const serialization = yield* RpcSerialization.RpcSerialization
    return (httpEffect: Effect.Effect<HttpServerResponse.HttpServerResponse, Types.unhandled>) =>
      Effect.gen(function*() {
        const request = yield* HttpServerRequest.HttpServerRequest
        const path = new URL(request.url, "http://gateway.invalid").pathname
        if (request.method !== "POST" || !rpcPaths.includes(path)) return yield* httpEffect
        // The mount itself dies on an unreadable body; this reads the same
        // cached effect, so a read failure is still the mount's to report.
        const body = yield* Effect.orDie(request.text)
        return carriesRpcRequest(serialization, body) ? yield* httpEffect : malformedRequest(path)
      })
  }),
  { global: true }
)

/**
 * The whole gateway surface, as one application layer a host serves.
 *
 * The caller supplies the transport serialization, the authentication
 * middleware for both RPC groups, and the services the mounts read through
 * (`Control`, `Projections`, `SyncServer`). `@smthrs/gateway/node/NodeGateway`
 * is the Node host that binds this to a socket.
 *
 * @param health the identity `GET /health` answers with
 * @param heartbeatMillis how often an idle followed `Watch` emits a keepalive,
 * defaulting to `Projections.heartbeatIntervalMillis`
 * @since 1.0.0
 * @category layers
 */
export const layer = (health: Health, heartbeatMillis?: number | undefined) =>
  Layer.mergeAll(
    layerControlHttp(heartbeatMillis),
    layerProjectionsHttp,
    layerSyncHttp,
    layerHealth(health),
    layerRefuseMalformedRpc
  )
