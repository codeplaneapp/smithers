/**
 * RPC client layer projected back into the control service interface.
 *
 * @since 0.1.0
 */
import { Effect, Layer, Schema, Stream } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import { RpcClient } from "effect/unstable/rpc"
import { Control, make, type Service } from "./Control.ts"
import { type ControlError, ControlErrorSchema, TransportError } from "./ControlError.ts"
import { ControlRpcs } from "./ControlRpcs.ts"

/**
 * Whether a value is one of the control plane's declared failures, as opposed
 * to a defect that escaped some other layer.
 *
 * Derived from `ControlError.ControlErrorSchema` rather than restated, so a new
 * error class cannot be a member of the union and a stranger to the client.
 *
 * @category refinements
 * @since 0.1.0
 * @slop
 */
export const isControlError = Schema.is(ControlErrorSchema)

const transportError = (error: unknown): TransportError =>
  new TransportError({
    message: error instanceof Error ? error.message : "Control RPC transport failed",
    retryable: true
  })

const normalize = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, ControlError, R> =>
  Effect.mapError(effect, (error) => isControlError(error) ? error : transportError(error))

/**
 * Client transport configuration. Unary procedures use HTTP at this URL;
 * `watch` uses the abstract WebSocket supplied by the platform layer.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface ClientConfig {
  readonly url: string
  /** Bearer token attached to every HTTP RPC request when present. */
  readonly credential?: string | undefined
}

/**
 * Provides `Control` through an RPC client while preserving the local vtable.
 *
 * @category layers
 * @since 0.1.0
 * @slop
 */
export const layer = (config: ClientConfig) => {
  const http = RpcClient.layerProtocolHttp(
    config.credential === undefined
      ? { url: config.url }
      : {
        url: config.url,
        transformClient: HttpClient.mapRequest(HttpClientRequest.bearerToken(config.credential))
      }
  )
  const websocket = RpcClient.layerProtocolSocket()
  return Layer.effect(
    Control,
    Effect.gen(function*() {
      // Built into the layer's own scope: `Effect.provide(layer)` would close
      // each protocol as soon as the client was constructed.
      const httpServices = yield* Layer.build(http)
      const websocketServices = yield* Layer.build(websocket)
      const unary = yield* RpcClient.make(ControlRpcs).pipe(Effect.provide(httpServices))
      const streaming = yield* RpcClient.make(ControlRpcs).pipe(Effect.provide(websocketServices))
      return make({
        plan: Effect.fn("Control.plan")((input) => normalize(unary.Plan(input))),
        run: Effect.fn("Control.run")((input) => normalize(unary.Run(input))),
        approve: Effect.fn("Control.approve")((input) => normalize(unary.Approve(input))),
        deny: Effect.fn("Control.deny")((input) => normalize(unary.Deny(input))),
        steer: Effect.fn("Control.steer")((input) => normalize(unary.Steer(input))),
        signal: Effect.fn("Control.signal")((input) => normalize(unary.Signal(input))),
        cancel: Effect.fn("Control.cancel")((input) => normalize(unary.Cancel(input))),
        resume: Effect.fn("Control.resume")((input) => normalize(unary.Resume(input))),
        list: Effect.fn("Control.list")((input) => normalize(unary.List(input))),
        watch: (input) =>
          Stream.mapError(streaming.Watch(input), (error) => isControlError(error) ? error : transportError(error))
      } as Service)
    })
  )
}
