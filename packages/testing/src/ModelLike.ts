/**
 * Structural model seam coordinated read-only with `packages/model`.
 *
 * @since 0.0.0
 */
import { Context } from "effect"
import type { Stream } from "effect"
import type { CapabilityContractError, ReplayHarnessMismatchError, UnscriptedModelError } from "./TestingError.ts"

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
}

/**
 * The public event shape of `/model/ModelEvent`, copied structurally
 * from its streaming protocol.
 *
 * @since 0.0.0
 * @category models
 */
export type ModelEventLike =
  | { readonly type: "text-start"; readonly id: string }
  | { readonly type: "text-delta"; readonly id: string; readonly text: string }
  | { readonly type: "text-end"; readonly id: string }
  | { readonly type: "thinking-start"; readonly id: string; readonly signature?: string }
  | { readonly type: "thinking-delta"; readonly id: string; readonly text: string }
  | { readonly type: "thinking-end"; readonly id: string }
  | { readonly type: "tool-call-start"; readonly id: string; readonly name: string }
  | { readonly type: "tool-call-delta"; readonly id: string; readonly arguments: string }
  | { readonly type: "tool-call-end"; readonly id: string; readonly arguments?: string }
  | {
    readonly type: "usage"
    readonly inputTokens?: number
    readonly outputTokens?: number
    readonly reasoningTokens?: number
    readonly cachedInputTokens?: number
    readonly cacheWriteTokens?: number
    readonly totalTokens?: number
  }
  | {
    readonly type: "settle"
    readonly stopReason: "stop" | "length" | "tool-calls" | "content-filter" | "error" | "aborted" | "unknown"
    readonly responseId?: string
    readonly itemIds?: ReadonlyArray<string>
  }

/**
 * The public error shape of `/model/ModelError`, copied structurally
 * without importing the model package.
 *
 * @since 0.0.0
 * @category errors
 */
export interface ModelErrorLike {
  readonly code:
    | "invalid_request"
    | "no_route"
    | "authentication"
    | "rate_limited"
    | "quota_exceeded"
    | "content_policy"
    | "provider_internal"
    | "transport"
    | "invalid_provider_output"
    | "permission_required"
    | "permission_denied"
    | "duplicate_request"
    | "request_not_found"
    | "journal_failed"
    | "store_closed"
    | "invalid_resolution"
    | "unknown"
  readonly message: string
  readonly retryAfterMillis?: number
  readonly resetAtEpochMillis?: number
  readonly resetSource?: string
  readonly providerCode?: string
  readonly requestId?: string
  readonly httpStatus?: number
}

/**
 * Errors surfaced by the local model port. Production model failures retain
 * the exact `/model` shape; fixture contract failures are added only by
 * the recorded-model layer.
 *
 * @since 0.0.0
 * @category errors
 */
export type ModelLikeError =
  | CapabilityContractError
  | ModelErrorLike
  | ReplayHarnessMismatchError
  | UnscriptedModelError

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
