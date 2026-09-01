/**
 * Run-local approval decoration.
 *
 * @see docs/specs/Concepts/Injection And Decoration.md
 *
 * @since 0.1.0
 */
import { Flow, Node } from "@smthrs/core"
import * as Schema from "effect/Schema"
import * as Compose from "./internal/Compose.ts"
import * as Pattern from "./Pattern.ts"
import { PatternError } from "./PatternError.ts"

/**
 * The sole value accepted from an approval step.
 *
 * A denial cannot decode as this schema and therefore fails on the typed
 * schema-error channel before the inner flow starts.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Approved = Schema.Literal("approved")

/**
 * An accepted approval decision.
 *
 * @category models
 * @since 0.1.0
 */
export type Approved = typeof Approved.Type

/**
 * Approval declaration options.
 *
 * @category models
 * @since 0.1.0
 */
export interface Options {
  readonly reason: string
  /**
   * Called with `{ input, reason, scope }`; its declared input must be that
   * struct or `Schema.Unknown`. `scope` is currently the string `"run"`.
   */
  readonly approval: Flow.Any
}

const ApprovalInput = Schema.Struct({
  input: Schema.Unknown,
  reason: Schema.String,
  scope: Schema.String
})

const declaration = (inner: Flow.Any, options: Options): Flow.Any => {
  if (options.reason.trim().length === 0) {
    throw new PatternError({
      code: "invalid_decorator",
      message: "Approval reason must not be empty"
    })
  }
  const approval = Pattern.bind(
    Pattern.slot({ input: ApprovalInput, output: Approved }),
    options.approval
  )
  const details = Compose.details(inner)
  return Flow.make({
    name: `withApproval(${Compose.displayName(inner)})`,
    description: details.description,
    input: details.input,
    output: details.output,
    capabilities: details.capabilities,
    effects: details.effects,
    flows: [approval, inner],
    body: Node.capture({ reason: options.reason }, (input) =>
      Node.andThen(
        Compose.call(approval, {
          input,
          reason: options.reason,
          scope: "run"
        }),
        Node.capture({ reason: options.reason }, () => Compose.call(inner, input))
      ))
  })
}

/**
 * Builds a run-scoped approval decorator.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (options: Options): Pattern.Decorator => (inner) => declaration(inner, options)

/**
 * Runs a caller-supplied, typed approval flow before the wrapped flow.
 *
 * The approval flow must decode its output as the literal `"approved"`;
 * denial therefore fails that flow and cannot advance to the inner flow.
 *
 * @category combinators
 * @since 0.1.0
 */
export const withApproval = (inner: Flow.Any, options: Options): Flow.Any => Pattern.decorate(inner, make(options))
