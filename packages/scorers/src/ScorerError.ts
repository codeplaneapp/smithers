/**
 * Stable scorer failures.
 *
 * @since 0.1.0
 */
import * as Schema from "effect/Schema"

/**
 * Stable scorer failure codes.
 *
 * @category models
 * @since 0.1.0
 */
export const ScorerErrorCode = Schema.Literals(["invalid_score", "invalid_sampling", "inconclusive", "store"])

/**
 * Stable scorer failure code.
 *
 * @category models
 * @since 0.1.0
 */
export type ScorerErrorCode = typeof ScorerErrorCode.Type

/**
 * A typed scorer declaration, execution, or persistence failure.
 *
 * @category errors
 * @since 0.1.0
 */
export class ScorerError extends Schema.TaggedError<ScorerError>()("flows/scorers/ScorerError", {
  code: ScorerErrorCode,
  message: Schema.String,
  cause: Schema.optional(Schema.Defect())
}) {}
