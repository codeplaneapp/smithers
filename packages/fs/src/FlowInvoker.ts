/**
 * The seam between a resolved route and whatever actually runs a flow.
 *
 * @since 0.1.0
 */
import type * as Flow from "@smthrs/core/Flow"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { FsError } from "./FsError.ts"

/**
 * One materialized invocation.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface Invocation {
  readonly name: string
  readonly flow: Flow.Any
  readonly input: unknown
}

/**
 * Executes a materialized flow.
 *
 * The projections in this package never execute a flow themselves: the harness
 * owns the run loop, permissions, and durability, so it supplies this service.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface Service {
  readonly invoke: (invocation: Invocation) => Effect.Effect<unknown, FsError>
}

/**
 * The flow invocation service.
 *
 * @category services
 * @since 0.1.0
 * @slop
 */
export class FlowInvoker extends Context.Service<FlowInvoker, Service>()("/fs/FlowInvoker") {}

/**
 * Constructs a flow invoker from an implementation.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const make = (implementation: Service): Service => FlowInvoker.of(implementation)

/**
 * Constructs an invoker that fails every invocation.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const makeNoop = (overrides: Partial<Service> = {}): Service =>
  make({
    invoke: Effect.fn("FlowInvoker.invoke")((invocation) =>
      Effect.fail(
        new FsError({
          code: "load_failed",
          method: "FlowInvoker.invoke",
          description: `No flow invoker is available to run "${invocation.name}"`
        })
      )
    ),
    ...overrides
  })

/**
 * Provides an invoker that fails every invocation.
 *
 * @category layers
 * @since 0.1.0
 * @slop
 */
export const layerNoop = (overrides: Partial<Service> = {}): Layer.Layer<FlowInvoker> =>
  Layer.succeed(FlowInvoker, makeNoop(overrides))
