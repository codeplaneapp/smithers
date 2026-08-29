/**
 * The assembled workspace gateway: one HTTP surface carrying the control
 * plane, the sync read path, the served projections, and a health probe.
 *
 * Mounts:
 *
 * | Path | Protocol | Serves |
 * | --- | --- | --- |
 * | `POST /rpc` | RPC over HTTP | `@smthrs/control` `ControlRpcs` |
 * | `/rpc/ws` | RPC over WebSocket | `ControlRpcs`, including `Watch` |
 * | `POST /projections` | RPC over HTTP | `GatewayRpcs` |
 * | `/projections/ws` | RPC over WebSocket | `GatewayRpcs`, including `Projection.Subscribe` |
 * | `POST /sync` | RPC over HTTP | `@smthrs/sync` `SyncRpcs` |
 * | `/sync/ws` | RPC over WebSocket | `SyncRpcs` |
 * | `GET /health` | JSON | `GatewaySchema.GatewayHealth` plus the package version |
 *
 * `/health` is deliberately unauthenticated: a supervisor decides whether to
 * keep or replace a gateway process by asking which workspace it belongs to,
 * and a probe that needed a credential could not answer that question about a
 * gateway it did not start. The response carries identity only — the
 * workspace hash, the gateway id, the protocol version, and the package
 * version — never a token, a run, or a path.
 *
 * @since 1.0.0
 */
import { Control } from "@smthrs/control/Control"
import * as ControlServer from "@smthrs/control/ControlServer"
import { SyncRpcs } from "@smthrs/sync/SyncRpcs"
import * as SyncServer from "@smthrs/sync/SyncServer"
import { Effect, Layer, Schema } from "effect"
import { HttpRouter, HttpServerResponse } from "effect/unstable/http"
import { RpcServer } from "effect/unstable/rpc"
import { GatewayRpcs } from "./GatewayRpcs.ts"
import * as GatewaySchema from "./GatewaySchema.ts"
import { Projections } from "./Projections.ts"

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
 * The whole gateway surface, as one application layer a host serves.
 *
 * The caller supplies the transport serialization, the authentication
 * middleware for both RPC groups, and the services the mounts read through
 * (`Control`, `Projections`, `SyncServer`). `@smthrs/gateway/node/NodeGateway`
 * is the Node host that binds this to a socket.
 *
 * @param health the identity `GET /health` answers with
 * @since 1.0.0
 * @category layers
 */
export const layer = (health: Health) =>
  Layer.mergeAll(
    ControlServer.layerHttp,
    layerProjectionsHttp,
    layerSyncHttp,
    layerHealth(health)
  )
