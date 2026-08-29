// Deep reviewed and polished by a human on 2026-08-10.

/**
 * Failure raised when a flow execution has no explicit or derived identity.
 *
 * @since 0.1.0
 */
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

/**
 * A flow execution was requested without either a caller-selected
 * execution ID or an opt-in flow idempotency key.
 *
 * @category errors
 * @since 0.1.0
 * @slop
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
