/**
 * Sequential escalation pattern.
 *
 * @see docs/specs/Concepts/Higher Order Flows.md
 *
 * @since 0.1.0
 */
import { Flow, Node } from "@smthrs/core"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { PatternError } from "./PatternError.ts"

/**
 * Configuration for {@link make}.
 *
 * Rungs are alternative strategies, not model-seat fallback. Provider or
 * seat fallback belongs to model routing before a flow is selected.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface MakeOptions {
  readonly rungs: ReadonlyArray<Flow.Any>
  readonly accept: Flow.Any
}

/**
 * Operational callbacks for {@link run}.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface RuntimeOptions<I, A, E, R, E2, R2> {
  readonly rungs: ReadonlyArray<(input: I) => Effect.Effect<A, E, R>>
  readonly accept: (result: A) => Effect.Effect<unknown, E2, R2>
}

const call = (flow: Flow.Any, input: unknown): Node.Node<unknown, unknown> =>
  (flow as unknown as (input: unknown) => Node.Node<unknown, unknown>)(input)

const accepted = (value: unknown): boolean =>
  value === true ||
  value === "approved" ||
  (
    typeof value === "object" &&
    value !== null &&
    "accepted" in value &&
    value.accepted === true
  )

/**
 * Builds the conservative bounded ladder topology, including every rung.
 * Use {@link run} for runtime acceptance and short-circuiting.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const make = (options: MakeOptions): Flow.Flow<typeof Schema.Unknown, typeof Schema.Unknown, unknown> => {
  if (options.rungs.length === 0) {
    throw new PatternError({ code: "exhausted", message: "Escalation requires at least one rung" })
  }
  return Flow.make({
    input: Schema.Unknown,
    output: Schema.Unknown,
    flows: [...options.rungs, options.accept],
    body: Node.capture({ rungs: options.rungs.length }, (input) => {
      const visit = (index: number): Node.Node<unknown, unknown> => {
        const rung = options.rungs[index]
        if (rung === undefined) {
          return Node.succeed({ accepted: false, exhausted: true })
        }
        return Node.andThen(
          call(rung, input),
          Node.capture(
            { rung: index },
            (result) =>
              Node.andThen(
                call(options.accept, result),
                Node.capture({ rung: index }, (decision) =>
                  accepted(decision)
                    ? Node.succeed(result)
                    : visit(index + 1))
              )
          )
        )
      }
      return visit(0)
    })
  })
}

/**
 * Executes an escalation ladder and stops after the first accepted result.
 *
 * This is the operational boundary for value-dependent branching. Core graph
 * planning intentionally evaluates `Node.andThen` builders with symbolic
 * values, so the flow declaration remains a conservative topology while this
 * Effect performs the runtime branch. Fiber interruption propagates normally.
 *
 * @category combinators
 * @since 0.1.0
 * @slop
 */
export const run = <I, A, E, R, E2, R2>(
  input: I,
  options: RuntimeOptions<I, A, E, R, E2, R2>
): Effect.Effect<A, E | E2 | PatternError, R | R2> => {
  if (options.rungs.length === 0) {
    return Effect.fail(new PatternError({ code: "exhausted", message: "Escalation requires at least one rung" }))
  }
  return Effect.gen(function*() {
    for (const rung of options.rungs) {
      const result = yield* rung(input)
      if (accepted(yield* options.accept(result))) return result
    }
    return yield* Effect.fail(
      new PatternError({ code: "exhausted", message: "Escalation exhausted every rung without acceptance" })
    )
  })
}
