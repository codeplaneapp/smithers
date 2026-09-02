/**
 * update_plan flow declaration and portable handler.
 *
 * A Codex CLI clone of the `update_plan` tool: an optional explanation and a
 * list of plan items, acknowledged with "Plan updated". Pure — no host
 * access; the harness observes plan updates through the journal.
 *
 * @since 0.1.0
 */
import * as Flow from "@smthrs/core/Flow"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { envelope } from "./internal/Declaration.ts"
import type * as StdError from "./StdError.ts"

/**
 * Registry name for the update_plan flow. Matches the Codex CLI tool name.
 *
 * @category identifiers
 * @since 0.1.0
 */
export const name = "update_plan"

/**
 * Model-facing description of the update_plan flow. Matches the Codex CLI
 * description.
 *
 * @category descriptions
 * @since 0.1.0
 */
export const description = "Updates the task plan.\n" +
  "Provide an optional explanation and a list of plan items, each with a step and status.\n"

/**
 * Status of one plan step, matching Codex.
 *
 * @category schemas
 * @since 0.1.0
 */
export const StepStatus = Schema.Literals(["pending", "in_progress", "completed"])

/**
 * Input schema for the update_plan flow.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Input = Schema.Struct({
  explanation: Schema.optional(Schema.String.annotate({ description: "Optional explanation for this plan update." })),
  plan: Schema.Array(
    Schema.Struct({
      step: Schema.String.annotate({ description: "Task step text." }),
      status: StepStatus.annotate({ description: "Step status." })
    })
  ).annotate({ description: "The list of steps" })
})

/**
 * Output schema for the update_plan flow.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Output = Schema.Struct({
  output: Schema.String.annotate({ description: "Acknowledgement text, always 'Plan updated'" })
})

/**
 * Static effect envelope for the update_plan flow: no reads, no writes.
 *
 * @category effects
 * @since 0.1.0
 */
export const effects = envelope({ tier: "sealed", mode: "hermetic", reads: [], writes: [] })

/**
 * Narrows the effect envelope for a decoded invocation.
 *
 * The flow touches nothing, so every invocation declares what the static
 * envelope declares.
 *
 * @category effects
 * @since 0.1.0
 */
export const effectsFor = (_input: typeof Input.Type) => effects

/**
 * Capabilities required by the update_plan flow: none.
 *
 * @category capabilities
 * @since 0.1.0
 */
export const capabilities: ReadonlyArray<string> = []

/**
 * Declaration-only update_plan flow.
 *
 * @category flows
 * @since 0.1.0
 */
export const flow = Flow.make({ name, description, input: Input, output: Output, capabilities, effects })

/**
 * Acknowledges a plan update with Codex's exact response text.
 *
 * @category handlers
 * @since 0.1.0
 */
export const run = Effect.fn("UpdatePlan.run")(function*(
  _input: typeof Input.Type
): Effect.fn.Return<typeof Output.Type, StdError.StdError> {
  return yield* Effect.succeed({ output: "Plan updated" })
})
