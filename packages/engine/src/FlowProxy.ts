// Deep reviewed and polished by a human on 2026-08-10.

/**
 * RPC and HTTP API definitions for flows.
 *
 * Given one or more `Flow` values, `toRpcGroup` creates the RPC definitions
 * for clients and servers, while `toHttpApiGroup` creates HTTP POST endpoints
 * that can be mounted in an API. Each flow gets execute, discard, and
 * resume operations, so callers can start a flow or resume a suspended run
 * by `executionId` without importing the flow handler directly.
 *
 * @since 0.1.0
 */
import type { Flow } from "@smthrs/flow"
import type { NonEmptyReadonlyArray } from "effect/Array"
import * as Schema from "effect/Schema"
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint"
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup"
import * as Rpc from "effect/unstable/rpc/Rpc"
import * as RpcGroup from "effect/unstable/rpc/RpcGroup"

const OptionalExecutionId = Schema.optional(Schema.String)

/**
 * Raised before proxy construction when two flow operations share one wire
 * identity.
 *
 * @category errors
 * @since 1.0.0
 */
export class FlowProxyCollision extends Error {
  readonly code = "flow_proxy_collision"
  readonly operation: string

  constructor(operation: string) {
    super(`Flow proxy operation ${JSON.stringify(operation)} is not unique`)
    this.name = "FlowProxyCollision"
    this.operation = operation
  }
}

/**
 * The three wire operation names one flow owns.
 *
 * @category models
 * @since 1.0.0
 */
export interface OperationAddresses {
  readonly execute: string
  readonly discard: string
  readonly resume: string
}

/**
 * Derives operation names shared by proxy definitions and server handlers.
 *
 * @category constructors
 * @since 1.0.0
 */
export const operationAddresses = (tag: string, prefix = ""): OperationAddresses => ({
  execute: `${prefix}${tag}`,
  discard: `${prefix}${tag}Discard`,
  resume: `${prefix}${tag}Resume`
})

/**
 * Refuses a flow set whose generated operation names are ambiguous.
 *
 * @category validation
 * @since 1.0.0
 */
export const assertNoCollisions = (
  flows: ReadonlyArray<Flow.Any>,
  prefix = ""
): void => {
  const seen = new Set<string>()
  for (const flow of flows) {
    for (const operation of Object.values(operationAddresses(flow._tag, prefix))) {
      if (seen.has(operation)) throw new FlowProxyCollision(operation)
      seen.add(operation)
    }
  }
}

type ExecutePayload<Payload extends Flow.AnyStructSchema> = Schema.Struct<{
  readonly payload: Payload
  readonly executionId: typeof OptionalExecutionId
}>

const executePayload = <Payload extends Flow.AnyStructSchema>(
  payload: Payload
): ExecutePayload<Payload> =>
  Schema.Struct({
    payload,
    executionId: OptionalExecutionId
  })

/**
 * Derives an `RpcGroup` from a list of flows.
 *
 * **Example** (Deriving RPC endpoints from flows)
 *
 * ```ts
 * import { Layer, Schema } from "effect"
 * import { RpcServer } from "effect/unstable/rpc"
 * import { FlowProxy, FlowProxyServer } from "@smthrs/engine"
 * import { Flow } from "@smthrs/flow"
 *
 * const EmailFlow = Flow.make("EmailFlow", {
 *   payload: {
 *     id: Schema.String,
 *     to: Schema.String
 *   },
 *   idempotencyKey: ({ id }) => id
 * })
 *
 * const myFlows = [EmailFlow] as const
 *
 * // Use FlowProxy.toRpcGroup to create a `RpcGroup` from the
 * // flows
 * class MyRpcs extends FlowProxy.toRpcGroup(myFlows) {}
 *
 * // Use FlowProxyServer.layerRpcHandlers to create a layer that implements
 * // the rpc handlers
 * const ApiLayer = RpcServer.layer(MyRpcs).pipe(
 *   Layer.provide(FlowProxyServer.layerRpcHandlers(myFlows))
 * )
 * ```
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const toRpcGroup = <
  const Flows extends NonEmptyReadonlyArray<Flow.Any>,
  const Prefix extends string = ""
>(
  flows: Flows,
  options?: {
    readonly prefix?: Prefix | undefined
  }
): RpcGroup.RpcGroup<ConvertRpcs<Flows[number], Prefix>> => {
  const prefix = options?.prefix ?? ""
  assertNoCollisions(flows, prefix)
  const rpcs: Array<Rpc.Any> = []
  for (const flow_ of flows) {
    const flow = flow_ as Flow.AnyWithProps
    const operation = operationAddresses(flow._tag, prefix)
    rpcs.push(
      Rpc.make(operation.execute, {
        payload: executePayload(flow.payloadSchema),
        error: flow.errorSchema,
        success: flow.successSchema
      }).annotateMerge(flow.annotations),
      Rpc.make(operation.discard, {
        payload: executePayload(flow.payloadSchema)
      }).annotateMerge(flow.annotations),
      Rpc.make(operation.resume, { payload: ResumePayload })
        .annotateMerge(flow.annotations)
    )
  }
  return RpcGroup.make(...rpcs) as any
}

/**
 * Maps each flow to the RPC definitions generated for execute, discard,
 * and resume operations.
 *
 * @category converting
 * @since 0.1.0
 * @slop
 */
export type ConvertRpcs<Flows extends Flow.Any, Prefix extends string> = Flows extends Flow.Flow<
  infer _Name,
  infer _Payload,
  infer _Success,
  infer _Error,
  infer _Requires
> ?
    | Rpc.Rpc<`${Prefix}${_Name}`, ExecutePayload<_Payload>, _Success, _Error>
    | Rpc.Rpc<`${Prefix}${_Name}Discard`, ExecutePayload<_Payload>>
    | Rpc.Rpc<`${Prefix}${_Name}Resume`, typeof ResumePayload>
  : never

/**
 * Derives an `HttpApiGroup` from a list of flows.
 *
 * **Example** (Deriving HTTP API endpoints from flows)
 *
 * ```ts
 * import { Layer, Schema } from "effect"
 * import { HttpApi, HttpApiBuilder } from "effect/unstable/httpapi"
 * import { FlowProxy, FlowProxyServer } from "@smthrs/engine"
 * import { Flow } from "@smthrs/flow"
 *
 * const EmailFlow = Flow.make("EmailFlow", {
 *   payload: {
 *     id: Schema.String,
 *     to: Schema.String
 *   },
 *   idempotencyKey: ({ id }) => id
 * })
 *
 * const myFlows = [EmailFlow] as const
 *
 * // Use FlowProxy.toHttpApiGroup to create a `HttpApiGroup` from the
 * // flows
 * class MyApi extends HttpApi.make("api")
 *   .add(FlowProxy.toHttpApiGroup("flows", myFlows))
 * {}
 *
 * // Use FlowProxyServer.layerHttpApi to create a layer that implements the
 * // flows HttpApiGroup
 * const ApiLayer = HttpApiBuilder.layer(MyApi).pipe(
 *   Layer.provide(
 *     FlowProxyServer.layerHttpApi(MyApi, "flows", myFlows)
 *   )
 * )
 * ```
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const toHttpApiGroup = <const Name extends string, const Flows extends NonEmptyReadonlyArray<Flow.Any>>(
  name: Name,
  flows: Flows
): HttpApiGroup.HttpApiGroup<Name, ConvertHttpApi<Flows[number]>> => {
  assertNoCollisions(flows)
  let group = HttpApiGroup.make(name)
  for (const flow_ of flows) {
    const flow = flow_ as Flow.AnyWithProps
    const operation = operationAddresses(flow._tag)
    const path = `/${tagToPath(flow._tag)}` as const
    group = group.add(
      HttpApiEndpoint.post(operation.execute, path, {
        payload: executePayload(flow.payloadSchema),
        success: flow.successSchema,
        error: flow.errorSchema
      }).annotateMerge(flow.annotations),
      HttpApiEndpoint.post(operation.discard, `${path}/discard`, {
        payload: executePayload(flow.payloadSchema)
      }).annotateMerge(flow.annotations),
      HttpApiEndpoint.post(operation.resume, `${path}/resume`, {
        payload: ResumePayload
      }).annotateMerge(flow.annotations)
    ) as any
  }
  return group as any
}

const wellFormed = (value: string): boolean => {
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index)
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(++index)
      if (next < 0xdc00 || next > 0xdfff) return false
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false
  }
  return true
}

const tagToPath = (tag: string): string => {
  if (!wellFormed(tag)) throw new FlowProxyCollision(tag)
  // Routers disagree about whether a percent-encoded slash is decoded before
  // matching. UTF-16 hex is injective, URL-safe, and remains one segment in
  // every adapter while preserving case and normalization distinctions.
  let encoded = "flow-"
  for (let index = 0; index < tag.length; index++) encoded += tag.charCodeAt(index).toString(16).padStart(4, "0")
  return encoded
}

/**
 * Maps each flow to the HTTP API endpoints generated for execute,
 * discard, and resume operations.
 *
 * @category converting
 * @since 0.1.0
 * @slop
 */
export type ConvertHttpApi<Flows extends Flow.Any> = Flows extends Flow.Flow<
  infer _Name,
  infer _Payload,
  infer _Success,
  infer _Error,
  infer _Requires
> ?
    | HttpApiEndpoint.HttpApiEndpoint<
      _Name,
      "POST",
      `/${string}`,
      never,
      never,
      ExecutePayload<_Payload>,
      never,
      _Success,
      _Error
    >
    | HttpApiEndpoint.HttpApiEndpoint<
      `${_Name}Discard`,
      "POST",
      `/${string}/discard`,
      never,
      never,
      ExecutePayload<_Payload>
    >
    | HttpApiEndpoint.HttpApiEndpoint<
      `${_Name}Resume`,
      "POST",
      `/${string}/resume`,
      never,
      never,
      typeof ResumePayload
    > :
  never

const ResumePayload = Schema.Struct({ executionId: Schema.String })
