/**
 * The typed failures evaluation raises, with the stable codes a gate or a
 * report branches on.
 *
 * @since 0.1.0
 */
import * as Schema from "effect/Schema"

/**
 * Stable evaluation failure codes.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export const EvalErrorCode = Schema.Literals(["invalid_suite", "invalid_baseline", "missing_ground_truth", "executor"])

/**
 * Stable evaluation failure code.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type EvalErrorCode = typeof EvalErrorCode.Type

/**
 * A typed failure raised while loading or executing an evaluation.
 *
 * @category errors
 * @since 0.1.0
 * @slop
 */
export class EvalError extends Schema.TaggedError<EvalError>()("flows/evals/EvalError", {
  code: EvalErrorCode,
  message: Schema.String,
  cause: Schema.optional(Schema.Defect())
}) {}
