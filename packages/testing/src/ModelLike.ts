/**
 * Structural model seam coordinated read-only with `packages/model`.
 *
 * @since 0.0.0
 */
import { Context } from "effect"
import type { Stream } from "effect"
import type { CapabilityContractError } from "./TestingError.ts"

/**
 * The public request shape of `/model/ModelRequest`, copied structurally
 * so this package does not depend on the unsettled model contract.
 *
 * @since 0.0.0
 * @category models
 */
export interface ModelRequestLike {
  readonly modelId: string
  readonly system: ReadonlyArray<{ readonly type: "text"; readonly text: string }>
  readonly messages: ReadonlyArray<
    | { readonly role: "user"; readonly content: ReadonlyArray<{ readonly type: "text"; readonly text: string }> }
    | {
      readonly role: "assistant"
      readonly content: ReadonlyArray<
        | { readonly type: "text"; readonly text: string }
        | { readonly type: "thinking"; readonly text: string; readonly signature?: string | undefined }
        | { readonly type: "tool-call"; readonly id: string; readonly name: string; readonly arguments: string }
      >
      readonly stopReason: "stop" | "length" | "tool-calls" | "content-filter" | "error" | "aborted" | "unknown"
      readonly responseId?: string | undefined
      readonly itemIds?: ReadonlyArray<string> | undefined
    }
    | {
      readonly role: "tool"
      readonly content: ReadonlyArray<{
        readonly type: "tool-result"
        readonly toolCallId: string
        readonly content: string
        readonly addedToolNames: ReadonlyArray<string>
      }>
    }
  >
  readonly tools: ReadonlyArray<{
    readonly name: string
    readonly description: string
    readonly parameters: Record<string, unknown>
    readonly deferred?: boolean | undefined
    readonly loader?: boolean | undefined
  }>
  readonly params: {
    readonly maxTokens?: number | undefined
    readonly temperature?: number | undefined
    readonly topP?: number | undefined
    readonly topK?: number | undefined
    readonly stopSequences?: ReadonlyArray<string> | undefined
    readonly thinkingBudget?: number | undefined
    readonly reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | undefined
  }
  /**
   * How the provider may use the declared tools. Only `none` is modelled,
   * matching `/model/ModelRequest`. It is declared request state rather than a
   * wire field, so two requests that differ only here are different calls and
   * must not share a replay digest.
   */
  readonly toolChoice?: "none" | undefined
}

/**
 * The public event shape of `/model/ModelEvent`, copied structurally
 * from its streaming protocol. Every member of that union is present,
 * including `tool-result` and `retry`: a recorder that dropped them would
 * write a fixture that replays a different stream than the one the provider
 * produced, and the tool output a harness reported is what feeds the next
 * request's tool message.
 *
 * @since 0.0.0
 * @category models
 */
export type ModelEventLike =
  | { readonly type: "text-start"; readonly id: string }
  | { readonly type: "text-delta"; readonly id: string; readonly text: string }
  | { readonly type: "text-end"; readonly id: string }
  | { readonly type: "thinking-start"; readonly id: string; readonly signature?: string | undefined }
  | { readonly type: "thinking-delta"; readonly id: string; readonly text: string }
  | { readonly type: "thinking-end"; readonly id: string }
  | { readonly type: "tool-call-start"; readonly id: string; readonly name: string }
  | { readonly type: "tool-call-delta"; readonly id: string; readonly arguments: string }
  | { readonly type: "tool-call-end"; readonly id: string; readonly arguments?: string | undefined }
  | {
    readonly type: "tool-result"
    readonly id: string
    readonly output: string
    readonly isError?: boolean | undefined
  }
  | {
    readonly type: "usage"
    readonly inputTokens?: number | undefined
    readonly outputTokens?: number | undefined
    readonly reasoningTokens?: number | undefined
    readonly cachedInputTokens?: number | undefined
    readonly cacheWriteTokens?: number | undefined
    readonly totalTokens?: number | undefined
  }
  | { readonly type: "retry"; readonly attempt: number; readonly code: string; readonly delayMillis: number }
  | {
    readonly type: "settle"
    readonly stopReason: "stop" | "length" | "tool-calls" | "content-filter" | "error" | "aborted" | "unknown"
    readonly responseId?: string | undefined
    readonly itemIds?: ReadonlyArray<string> | undefined
  }

/**
 * The public error shape of `/model/ModelError`, copied structurally
 * without importing the model package.
 *
 * `code` is exactly `/model/ModelError`'s `ModelErrorCode`. The permission and
 * grant-store codes this union used to also carry belong to
 * `/capability/Permission`: they are separate typed error classes that the
 * model package never raises as a `ModelError`, and a fixture that recorded one
 * as a provider failure would replay a kernel decision as a provider response.
 *
 * @since 0.0.0
 * @category errors
 */
export interface ModelErrorLike {
  readonly code:
    | "invalid_request"
    | "context_overflow"
    | "no_route"
    | "authentication"
    | "rate_limited"
    | "quota_exceeded"
    | "content_policy"
    | "provider_internal"
    | "transport"
    | "call_timeout"
    | "invalid_provider_output"
    | "unknown"
  readonly message: string
  readonly retryAfterMillis?: number | undefined
  readonly resetAtEpochMillis?: number | undefined
  readonly resetSource?: string | undefined
  readonly providerCode?: string | undefined
  readonly requestId?: string | undefined
  readonly httpStatus?: number | undefined
}

/**
 * Errors surfaced by the local model port. Production model failures retain
 * the exact `/model` shape; a poisoned double reports a capability contract
 * violation.
 *
 * `UnscriptedModelError` and `ReplayHarnessMismatchError` are deliberately not
 * here. Both say the same thing: the fixture does not describe this run. That
 * is a defect in the test, not an outcome the code under test can handle, and
 * neither is a member of `/model/Model`'s `ModelFailure`, so a replay model
 * that failed with one could not be adapted to the production seam without
 * laundering it into a provider code. Code that retries or falls back on
 * provider failures would then retry against a fixture that will never match,
 * and the test would pass or hang for the wrong reason. The replay model dies
 * on both instead: a defect cannot be caught by `Effect.catchTag` or a retry
 * schedule, and it fails the test at the call that has no recording.
 *
 * @since 0.0.0
 * @category errors
 */
export type ModelLikeError = CapabilityContractError | ModelErrorLike

/**
 * The model seam a test drives, structurally identical to
 * `@smthrs/model`'s `Model` but not depending on it.
 *
 * @category services
 * @since 0.0.0
 */
export interface ModelLike {
  readonly stream: (request: ModelRequestLike) => Stream.Stream<ModelEventLike, ModelLikeError>
}

/**
 * The {@link ModelLike} service tag.
 *
 * @category services
 * @since 0.0.0
 */
export const ModelLike: Context.Service<ModelLike, ModelLike> = Context.Service("flows/testing/ModelLike")

/**
 * Builds a {@link ModelLike} from an implementation of its one method.
 *
 * @category constructors
 * @since 0.0.0
 */
export const make = (implementation: ModelLike): ModelLike => ModelLike.of(implementation)
