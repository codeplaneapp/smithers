/**
 * The single failure type every time-travel operation can fail with.
 *
 * Inspect, fork, and rewind all fail as `TimeTravelError`, discriminated by a
 * `code` rather than by a family of tags: the callers that matter — a UI
 * offering "retry", a driver deciding whether to back off — branch on *why*
 * the operation was refused, and a closed code list keeps that branch
 * exhaustive. The tag itself is wire format, so it stays
 * `@smthrs/time-travel/TimeTravelError` even as the code list grows.
 *
 * @since 0.1.0
 */
import * as Schema from "effect/Schema"
/**
 * Why a time-travel operation was refused.
 *
 * `busy` — another rewind holds the run. `live_parent` / `live_child` — the
 * run or one of its descendants is still executing, so its history is not
 * settled enough to branch from or truncate. `not_found` — the run or frame
 * does not exist. `invalid` — a caller-supplied option is malformed, refused
 * before the operation touches anything. `rate_limited` — the rewind rate
 * limiter rejected the attempt. `compensation_failed` — a side effect's
 * rollback handler failed, so the rewind stopped rather than leave the world
 * half-reverted. `irreversible` — an effect in the truncated range cannot be
 * undone at all. `fence_lost` — the caller's ownership of the run was
 * superseded before a mutation committed, so the mutation was refused rather
 * than written behind the live owner. `unknown` — the store or an unmapped
 * host failure.
 *
 * @since 0.1.0
 * @category schemas
 */
export const TimeTravelErrorCode = Schema.Literals([
  "busy",
  "live_parent",
  "live_child",
  "not_found",
  "invalid",
  "rate_limited",
  "compensation_failed",
  "irreversible",
  "fence_lost",
  "unknown"
])
/**
 * The value form of {@link TimeTravelErrorCode}.
 *
 * @since 0.1.0
 * @category models
 */
export type TimeTravelErrorCode = typeof TimeTravelErrorCode.Type
/**
 * A refused time-travel operation, carrying the {@link TimeTravelErrorCode}
 * that says why, a human-readable message, and the underlying `cause` when one
 * exists.
 *
 * @since 0.1.0
 * @category errors
 */
export class TimeTravelError extends Schema.TaggedError<TimeTravelError>()("@smthrs/time-travel/TimeTravelError", {
  code: TimeTravelErrorCode,
  message: Schema.String,
  cause: Schema.optional(Schema.Unknown)
}) {}
/**
 * Creates a {@link TimeTravelError}, omitting `cause` entirely when none is
 * supplied so an absent cause never encodes as an explicit `undefined`.
 *
 * @since 0.1.0
 * @category constructors
 */
export const error = (code: TimeTravelErrorCode, message: string, cause?: unknown): TimeTravelError =>
  new TimeTravelError({ code, message, ...(cause === undefined ? {} : { cause }) })
