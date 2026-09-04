// Deep reviewed and polished by a human on 2026-08-10.

/**
 * Failure raised when a flow execution has no explicit or derived identity.
 *
 * @since 0.1.0
 */
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

/**
 * A flow execution has no selected identity.
 *
 * The default `CurrentExecutionIds` source raises this when neither the caller
 * nor the flow declaration selected an id. The opt-in `derived` source also
 * raises it when the payload cannot be canonicalized, for example a
 * non-finite number, a lone surrogate, or a cycle. Both die with it before
 * starting a run, so it is a defect and not a typed failure a body catches.
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
