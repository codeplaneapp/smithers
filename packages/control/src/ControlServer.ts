/**
 * RPC server layers for the control service.
 *
 * @since 0.1.0
 */
import { Effect, Layer } from "effect"
import { RpcServer } from "effect/unstable/rpc"
import { Control } from "./Control.ts"
import { ControlPrincipal, ControlRpcs } from "./ControlRpcs.ts"

/**
 * Control RPC handlers delegating to the transport-independent service.
 *
 * @category layers
 * @since 0.1.0
 * @slop
 */
export const layer = ControlRpcs.toLayer(
  Effect.gen(function*() {
    const control = yield* Control
    return ControlRpcs.of({
      Plan: Effect.fn("Control.plan")((input) => control.plan(input)),
      Run: Effect.fn("Control.run")((input) => control.run(input)),
      Approve: Effect.fn("Control.approve")((input) =>
        Effect.gen(function*() {
          const principal = yield* ControlPrincipal
          return yield* control.approve({ ...input, principal })
        })
      ),
      Deny: Effect.fn("Control.deny")((input) =>
        Effect.gen(function*() {
          const principal = yield* ControlPrincipal
          return yield* control.deny({ ...input, principal })
        })
      ),
      Steer: Effect.fn("Control.steer")((input) => control.steer(input)),
      Signal: Effect.fn("Control.signal")((input) => control.signal(input)),
      Cancel: Effect.fn("Control.cancel")((input) => control.cancel(input)),
      Resume: Effect.fn("Control.resume")((input) => control.resume(input)),
      List: Effect.fn("Control.list")((input) => control.list(input)),
      Watch: (input) => control.watch(input)
    })
  })
)

const server = RpcServer.layer(ControlRpcs, {
  disableFatalDefects: true
})

const http = server.pipe(
  Layer.provide(layer),
  Layer.provideMerge(RpcServer.layerProtocolHttp({ path: "/rpc" })),
  Layer.fresh
)

const websocket = server.pipe(
  Layer.provide(layer),
  Layer.provideMerge(RpcServer.layerProtocolWebsocket({ path: "/rpc/ws" })),
  Layer.fresh
)

/**
 * Mounts control RPC on the ambient `HttpRouter`: unary procedures over POST
 * `/rpc` and the `watch` stream over WebSocket `/rpc/ws`. Both protocols are
 * mounted together because `ControlClient` projects the same `Control` vtable
 * across the two transports.
 *
 * @category layers
 * @since 0.1.0
 * @slop
 */
export const layerHttp = Layer.mergeAll(
  http,
  websocket
)
