/** @since 0.1.0 */
import { Schema } from "effect"

/**
 * The provider-neutral failure vocabulary. A consumer branches on these
 * codes; provider message text is not a contract.
 *
 * All but one describe something the provider did. `call_timeout` describes
 * what the caller did: it exceeded a wall-clock budget it declared for the
 * call and interrupted the request itself, so the request never settled and
 * nothing about it is known. It is a distinct code rather than `transport`
 * because the two are repaired differently — a transport failure is waited
 * out unchanged, and an overrun is re-issued with the model told to be
 * shorter.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export const ModelErrorCode = Schema.Literals([
  "invalid_request",
  "context_overflow",
  "no_route",
  "authentication",
  "rate_limited",
  "quota_exceeded",
  "content_policy",
  "provider_internal",
  "transport",
  "call_timeout",
  "invalid_provider_output",
  "unknown"
])

/**
 * The decoded form of {@link ModelErrorCode}.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type ModelErrorCode = typeof ModelErrorCode.Type

/**
 * Wire signals that mean "this request did not fit the model's context window".
 *
 * Providers report overflow as an ordinary bad request, so the distinction only
 * exists in prose on the wire. It is recognized here, once, at the boundary that
 * owns provider vocabulary, and published as the `context_overflow` code. A
 * consumer deciding whether to compact and retry branches on that code — never
 * on message text, which is not a contract and changes without notice.
 */
const overflowSignal =
  /context(?:[-_ ](?:length|window))?[-_ ](?:exceeded|overflow)|context[-_ ]length[-_ ]exceeded|maximum context length|prompt (?:is )?too long|too many (?:input )?tokens|reduce the length of the messages/i

/**
 * Whether a provider's own error code and message describe a context overflow.
 *
 * Protocol adapters call this while classifying a wire failure, ahead of the
 * generic `invalid_request` branch, so overflow reaches consumers as a typed
 * code rather than as text they would have to re-parse.
 *
 * @category refinements
 * @since 0.1.0
 * @slop
 */
export const isContextOverflow = (providerCode: string | undefined, message: string): boolean =>
  overflowSignal.test(`${providerCode ?? ""} ${message}`)

/**
 * Normalized provider failure. Its fields intentionally exclude credentials,
 * headers, request bodies, and client objects.
 *
 * `code` is the stable serialized field and the public error contract
 * (`docs/reference/model.md`). There is no separate `reason` field: flows
 * deliberately flattens opencode's tagged reason union into this one literal
 * set plus typed optional detail fields — the deviation is declared in
 * `docs/specs/Concepts/Model Layer.md`. Kernel permission and journal
 * failures are separate typed error classes, never `ModelError` codes.
 *
 * @category errors
 * @since 0.1.0
 * @slop
 */
export class ModelError extends Schema.TaggedError<ModelError>()("flows/model/ModelError", {
  code: ModelErrorCode,
  message: Schema.String,
  retryAfterMillis: Schema.optional(Schema.Number),
  resetAtEpochMillis: Schema.optional(Schema.Number),
  resetSource: Schema.optional(Schema.String),
  providerCode: Schema.optional(Schema.String),
  requestId: Schema.optional(Schema.String),
  httpStatus: Schema.optional(Schema.Number)
}) {
  /** @category getters @since 0.1.0 */
  get retryable(): boolean {
    if (this.code === "quota_exceeded") return false
    return this.code === "rate_limited" || this.code === "provider_internal" || this.code === "transport" ||
      this.code === "call_timeout" ||
      this.httpStatus === 429 || (this.httpStatus !== undefined && this.httpStatus >= 500 && this.httpStatus <= 599)
  }
}
