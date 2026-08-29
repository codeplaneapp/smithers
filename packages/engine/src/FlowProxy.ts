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
 * @since 4.0.0
 */
import type { Flow } from "@smthrs/flow"
import type { NonEmptyReadonlyArray } from "effect/Array"
import * as Schema from "effect/Schema"
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint"
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup"
import * as Rpc from "effect/unstable/rpc/Rpc"
import * as RpcGroup from "effect/unstable/rpc/RpcGroup"

const OptionalExecutionId = Schema.optional(Schema.String)

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
 * @since 4.0.0
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
  const rpcs: Array<Rpc.Any> = []
  for (const flow_ of flows) {
    const flow = flow_ as Flow.AnyWithProps
    rpcs.push(
      Rpc.make(`${prefix}${flow._tag}`, {
        payload: executePayload(flow.payloadSchema),
        error: flow.errorSchema,
        success: flow.successSchema
      }).annotateMerge(flow.annotations),
      Rpc.make(`${prefix}${flow._tag}Discard`, {
        payload: executePayload(flow.payloadSchema)
      }).annotateMerge(flow.annotations),
      Rpc.make(`${prefix}${flow._tag}Resume`, { payload: ResumePayload })
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
 * @since 4.0.0
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
 * @since 4.0.0
 * @slop
 */
export const toHttpApiGroup = <const Name extends string, const Flows extends NonEmptyReadonlyArray<Flow.Any>>(
  name: Name,
  flows: Flows
): HttpApiGroup.HttpApiGroup<Name, ConvertHttpApi<Flows[number]>> => {
  let group = HttpApiGroup.make(name)
  for (const flow_ of flows) {
    const flow = flow_ as Flow.AnyWithProps
    const path = `/${tagToPath(flow._tag)}` as const
    group = group.add(
      HttpApiEndpoint.post(flow._tag, path, {
        payload: executePayload(flow.payloadSchema),
        success: flow.successSchema,
        error: flow.errorSchema
      }).annotateMerge(flow.annotations),
      HttpApiEndpoint.post(flow._tag + "Discard", `${path}/discard`, {
        payload: executePayload(flow.payloadSchema)
      }).annotateMerge(flow.annotations),
      HttpApiEndpoint.post(flow._tag + "Resume", `${path}/resume`, {
        payload: ResumePayload
      }).annotateMerge(flow.annotations)
    ) as any
  }
  return group as any
}

const tagToPath = (tag: string): string =>
  tag
    // .replace(/[^a-zA-Z0-9]+/g, "-") // Replace non-alphanumeric characters with hyphen
    // .replace(/([a-z])([A-Z])/g, "$1-$2") // Insert hyphen before uppercase letters
    .toLowerCase()

/**
 * Maps each flow to the HTTP API endpoints generated for execute,
 * discard, and resume operations.
 *
 * @category converting
 * @since 4.0.0
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
      `/${Lowercase<_Name>}`,
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
      `/${Lowercase<_Name>}/discard`,
      never,
      never,
      ExecutePayload<_Payload>
    >
    | HttpApiEndpoint.HttpApiEndpoint<
      `${_Name}Resume`,
      "POST",
      `/${Lowercase<_Name>}/resume`,
      never,
      never,
      typeof ResumePayload
    > :
  never

const ResumePayload = Schema.Struct({ executionId: Schema.String })
