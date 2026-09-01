// Deep reviewed and polished by a human on 2026-08-10.

/**
 * Failure raised when a flow execution has no explicit or derived identity.
 *
 * @since 0.1.0
 */
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

/**
 * A flow execution has no derivable identity, because its payload has no
 * canonical form.
 *
 * Executing without a caller-selected execution ID is ordinary: the ambient
 * `CurrentExecutionIds.derived` source mints one by hashing the flow tag and
 * the payload's canonical form. This is what that source raises when the
 * payload cannot BE canonicalized, for example a non-finite number, a lone
 * surrogate, or a cycle. `derived.mint` dies with it rather than starting a run
 * under a guessed identity, so it is a defect and not a typed failure a body
 * catches.
 *
 * @category errors
 * @since 0.1.0
 */
export class ExecutionIdRequired extends Schema.TaggedError<ExecutionIdRequired>()(
  "@smthrs/flow/ExecutionIdRequired",
  {
    code: Schema.Literal("execution_id_required").pipe(
      Schema.withConstructorDefault(Effect.succeed("execution_id_required"))
    ),
    flowName: Schema.String
  }
) {}
