/**
 * Stable trigger failures.
 *
 * @see docs/specs/Concepts/Flow Triggers.md
 * @see docs/specs/Concepts/Channels.md
 *
 * @since 0.1.0
 */
import * as Schema from "effect/Schema"

/**
 * Stable trigger failure codes.
 *
 * @category models
 * @since 0.1.0
 */
export const TriggerErrorCode = Schema.Literals([
  "unknown_trigger",
  "invalid_schedule",
  "invalid_trigger",
  "invalid_cron",
  "unsatisfiable_cron",
  "verification_failed",
  "catch_up_bound_exceeded",
  "store"
])

/**
 * Stable trigger failure code.
 *
 * @category models
 * @since 0.1.0
 */
export type TriggerErrorCode = typeof TriggerErrorCode.Type

/**
 * A typed schedule, verification, or persistence failure.
 *
 * @category errors
 * @since 0.1.0
 */
export class TriggerError extends Schema.TaggedError<TriggerError>()("flows/triggers/TriggerError", {
  code: TriggerErrorCode,
  message: Schema.String,
  cause: Schema.optional(Schema.Defect())
}) {}
