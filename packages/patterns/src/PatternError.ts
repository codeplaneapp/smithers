/**
 * Stable failures shared by higher-order flow patterns.
 *
 * @since 0.1.0
 */
import * as Schema from "effect/Schema"

/**
 * Stable pattern failure codes.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export const PatternErrorCode = Schema.Literals([
  "missing_slot",
  "recursion_bound",
  "envelope_conflict",
  "invalid_decorator",
  "exhausted"
])

/**
 * Stable pattern failure code.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type PatternErrorCode = typeof PatternErrorCode.Type

/**
 * A typed pattern declaration or execution failure.
 *
 * @category errors
 * @since 0.1.0
 * @slop
 */
export class PatternError extends Schema.TaggedError<PatternError>()("flows/patterns/PatternError", {
  code: PatternErrorCode,
  message: Schema.String
}) {}
