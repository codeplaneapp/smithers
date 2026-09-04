// Deep reviewed and polished by a human on 2026-08-10.

/**
 * Server-side layers for flow proxy APIs.
 *
 * `layerHttpApi` connects the HTTP API group created by `FlowProxy` to the
 * supplied flows. `layerRpcHandlers` does the same for the generated RPC
 * definitions. Both layers route execute, discard, and resume requests to the
 * matching flow operation, while the `FlowRuntime` and flow handler
 * services stay on the server side.
 *
 * A handler here calls `flow.execute`, so both layers require what the served
 * bodies require: `Flow.Requirements` of every flow, alongside the schema
 * services `Flow.RequirementsHandler` names. Serving a flow is executing it,
 * and the compile-time gate on a missing action implementation has to hold
 * on this side of an RPC boundary too — the client, which only encodes a
 * payload and decodes a result, still requires nothing of the kind.
 *
 * @since 0.1.0
 */
import type { Flow, FlowRuntime } from "@smthrs/flow"
import type { NonEmptyReadonlyArray } from "effect/Array"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import type * as HttpApi from "effect/unstable/httpapi/HttpApi"
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder"
import type * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup"
import type * as Rpc from "effect/unstable/rpc/Rpc"
import * as FlowProxy from "./FlowProxy.ts"

/**
 * Rewrites the caller-supplied execution id before it reaches the engine, so
 * a multi-tenant server namespaces client identity in one place instead of at
 * every call site.
 *
 * The server calls the function once inside each execute, discard, or resume
 * handler. Execute and discard inputs include the decoded flow payload, while
 * resume inputs use `undefined` because a resume request carries only an
 * execution id. Returning `undefined` for execute or discard lets the engine
 * derive the id from the flow's idempotency key. Returning `undefined` for
 * resume preserves the client value because `Flow.resume` requires a string.
 * Without this option, every client value passes through unchanged.
 *
 * Implementations must be pure and return for every input. The function
 * receives the flow and request payload, but no request-scoped service. Put a
 * trusted tenant in the payload through middleware, or wrap the layer with a
 * mapping that closes over the trusted namespace.
 *
 * @category models
 * @since 1.0.0
 */
export interface ExecutionIdScope {
  (input: {
    readonly flow: Flow.Any
    readonly operation: "execute" | "discard" | "resume"
    readonly clientValue: string | undefined
    readonly payload: unknown
  }): string | undefined
}

function scopeExecutionId(
  scope: ExecutionIdScope | undefined,
  input: Parameters<ExecutionIdScope>[0] & {
    readonly operation: "resume"
    readonly clientValue: string
  }
): string
function scopeExecutionId(
  scope: ExecutionIdScope | undefined,
  input: Parameters<ExecutionIdScope>[0]
): string | undefined
function scopeExecutionId(
  scope: ExecutionIdScope | undefined,
  input: Parameters<ExecutionIdScope>[0]
): string | undefined {
  if (scope === undefined) {
    return input.clientValue
  }
  const scoped = scope(input)
  return input.operation === "resume" && scoped === undefined ? input.clientValue : scoped
}

/**
 * Creates handlers for a flow HTTP API group, wiring execute, discard, and
 * resume endpoints to the supplied flows.
 *
 * @category layers
 * @since 0.1.0
 * @slop
 */
export const layerHttpApi = <
  ApiId extends string,
  Groups extends HttpApiGroup.Constraint,
  Identifier extends HttpApiGroup.Identifier<Groups>,
  const Flows extends NonEmptyReadonlyArray<Flow.Any>
>(
  api: HttpApi.HttpApi<ApiId, Groups>,
  identifier: Identifier,
  flows: Flows,
  options?: { readonly executionId?: ExecutionIdScope }
): Layer.Layer<
  HttpApiGroup.Service<ApiId, Identifier>,
  never,
  | FlowRuntime.FlowRuntime
  | Flow.Requirements<Flows[number]>
  | Flow.RequirementsHandler<Flows[number]>
> => {
  FlowProxy.assertNoCollisions(flows)
  return HttpApiBuilder.group(
    api,
    identifier,
    // Untraced because proxy handler construction recursively resolves flows.
    Effect.fnUntraced(function*(handlers: any) {
      for (const flow_ of flows) {
        const flow = flow_ as Flow.AnyWithProps
        const operation = FlowProxy.operationAddresses(flow._tag)
        handlers = handlers
          .handle(
            operation.execute,
            ({ payload: request }: {
              payload: {
                payload: any
                executionId: string
              }
            }) =>
              flow.execute(request.payload, {
                executionId: scopeExecutionId(options?.executionId, {
                  flow,
                  operation: "execute",
                  clientValue: request.executionId,
                  payload: request.payload
                })
              }).pipe(
                Effect.tapDefect(Effect.logError),
                Effect.annotateLogs({
                  module: "FlowProxyServer",
                  method: operation.execute
                })
              )
          )
          .handle(
            operation.discard,
            ({ payload: request }: {
              payload: {
                payload: any
                executionId: string
              }
            }) =>
              flow.execute(request.payload, {
                discard: true,
                executionId: scopeExecutionId(options?.executionId, {
                  flow,
                  operation: "discard",
                  clientValue: request.executionId,
                  payload: request.payload
                })
              }).pipe(
                Effect.tapDefect(Effect.logError),
                Effect.annotateLogs({
                  module: "FlowProxyServer",
                  method: operation.discard
                })
              )
          )
          .handle(
            operation.resume,
            ({ payload }: { payload: { readonly executionId: string } }) =>
              flow.resume(scopeExecutionId(options?.executionId, {
                flow,
                operation: "resume",
                clientValue: payload.executionId,
                payload: undefined
              })).pipe(
                Effect.tapDefect(Effect.logError),
                Effect.annotateLogs({
                  module: "FlowProxyServer",
                  method: operation.resume
                })
              )
          )
      }
      return handlers as HttpApiBuilder.Handlers<never>
    })
  )
}

/**
 * Creates RPC handlers for the supplied flows, wiring execute, discard,
 * and resume RPCs to flow operations.
 *
 * @category layers
 * @since 0.1.0
 * @slop
 */
export const layerRpcHandlers = <
  const Flows extends NonEmptyReadonlyArray<Flow.Any>,
  const Prefix extends string = ""
>(flows: Flows, options?: {
  readonly prefix?: Prefix
  readonly executionId?: ExecutionIdScope
}): Layer.Layer<
  RpcHandlers<Flows[number], Prefix>,
  never,
  | FlowRuntime.FlowRuntime
  | Flow.Requirements<Flows[number]>
  | Flow.RequirementsHandler<Flows[number]>
> => {
  const prefix = options?.prefix ?? ""
  FlowProxy.assertNoCollisions(flows, prefix)
  return Layer.effectContext(Effect.gen(function*() {
    const context = yield* Effect.context<never>()
    const handlers = new Map<string, Rpc.Handler<string>>()
    for (const flow_ of flows) {
      const flow = flow_ as Flow.AnyWithProps
      const operation = FlowProxy.operationAddresses(flow._tag, prefix)
      const tag = operation.execute
      const tagDiscard = operation.discard
      const tagResume = operation.resume
      const key = `effect/rpc/Rpc/${tag}`
      const keyDiscard = `${key}Discard`
      const keyResume = `${key}Resume`
      handlers.set(key, {
        context,
        tag,
        handler: (request: any) =>
          flow.execute(request.payload, {
            executionId: scopeExecutionId(options?.executionId, {
              flow,
              operation: "execute",
              clientValue: request.executionId,
              payload: request.payload
            })
          }).pipe(
            Effect.tapDefect(Effect.logError),
            Effect.annotateLogs({ module: "FlowProxyServer", method: tag })
          ) as any
      } as any)
      handlers.set(keyDiscard, {
        context,
        tag: tagDiscard,
        handler: (request: any) =>
          flow.execute(request.payload, {
            discard: true,
            executionId: scopeExecutionId(options?.executionId, {
              flow,
              operation: "discard",
              clientValue: request.executionId,
              payload: request.payload
            })
          }).pipe(
            Effect.tapDefect(Effect.logError),
            Effect.annotateLogs({ module: "FlowProxyServer", method: tagDiscard })
          ) as any
      } as any)
      handlers.set(keyResume, {
        context,
        tag: tagResume,
        handler: (payload: { readonly executionId: string }) =>
          flow.resume(scopeExecutionId(options?.executionId, {
            flow,
            operation: "resume",
            clientValue: payload.executionId,
            payload: undefined
          })).pipe(
            Effect.tapDefect(Effect.logError),
            Effect.annotateLogs({ module: "FlowProxyServer", method: tagResume })
          ) as any
      } as any)
    }
    return Context.makeUnsafe(handlers)
  }))
}

/**
 * Union of RPC handler services required to serve the generated flow
 * execute, discard, and resume RPCs.
 *
 * @category services
 * @since 0.1.0
 * @slop
 */
export type RpcHandlers<Flows extends Flow.Any, Prefix extends string> = Flows extends Flow.Flow<
  infer _Name,
  infer _Payload,
  infer _Success,
  infer _Error,
  infer _Requires
> ? Rpc.Handler<`${Prefix}${_Name}`> | Rpc.Handler<`${Prefix}${_Name}Discard`> | Rpc.Handler<`${Prefix}${_Name}Resume`>
  : never
