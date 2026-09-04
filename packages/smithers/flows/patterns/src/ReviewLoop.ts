/**
 * Bounded produce-review-revise pattern.
 *
 * @see https://smithers.sh/docs/reference/api/patterns
 * @see https://smithers.sh/docs/reference/api/patterns#identity-and-ownership
 *
 * @since 0.1.0
 */
import { Flow, Node } from "@smthrs/core"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Compose from "./internal/Compose.ts"
import { PatternError } from "./PatternError.ts"

/**
 * Configuration for {@link make}.
 *
 * `produce` receives the pattern input. `review` receives the produced value;
 * `revise` receives `{ output, review }`. Rounds are expanded at declaration
 * time so cancellation remains ordinary structured fiber interruption.
 *
 * @category models
 * @since 0.1.0
 */
export interface MakeOptions {
  readonly produce: Flow.Any
  readonly review: Flow.Any
  readonly revise: Flow.Any
  readonly maxRounds: number
}

/**
 * Operational callbacks for {@link run}.
 *
 * @category models
 * @since 0.1.0
 */
export interface RuntimeOptions<I, A, Review, E, R, E2, R2, E3, R3> {
  readonly produce: (input: I) => Effect.Effect<A, E, R>
  readonly review: (output: A, round: number) => Effect.Effect<Review, E2, R2>
  readonly revise: (input: {
    readonly output: A
    readonly review: Review
    readonly round: number
  }) => Effect.Effect<A, E3, R3>
  readonly maxRounds: number
}

/**
 * An unapproved result returned after the round bound is reached.
 *
 * @category models
 * @since 0.1.0
 */
export interface Exhausted<A, Review> {
  readonly output: A
  readonly review: Review
  readonly approved: false
  readonly exhausted: true
}

const call = (flow: Flow.Any, input: unknown): Node.Node<unknown, unknown> =>
  (flow as unknown as (input: unknown) => Node.Node<unknown, unknown>)(input)

/**
 * Reads an accepted decision: `true`, `"approved"`, `{ approved: true }`, or
 * `{ accepted: true }`.
 *
 * @category predicates
 * @since 0.1.0
 */
export const accepted = Compose.accepted

/**
 * Builds the conservative topology for every declared review round. Use
 * {@link run} for runtime approval and short-circuiting.
 * A very large `maxRounds` builds a very large graph before anything runs.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (options: MakeOptions): Flow.Flow<typeof Schema.Unknown, typeof Schema.Unknown, unknown> => {
  // The body runs when the graph builds, later than this call, so it reads
  // these snapshots and never the caller's options again.
  const stages = { produce: options.produce, review: options.review, revise: options.revise }
  const maxRounds = options.maxRounds
  if (!Number.isSafeInteger(maxRounds) || maxRounds < 1) {
    throw new PatternError({
      code: "invalid_decorator",
      message: "ReviewLoop maxRounds must be a positive safe integer"
    })
  }
  return Flow.make({
    input: Schema.Unknown,
    output: Schema.Unknown,
    flows: [stages.produce, stages.review, stages.revise],
    body: Node.capture(
      { maxRounds },
      (input) =>
        Node.andThen(
          call(stages.produce, input),
          Node.capture({ maxRounds }, (initial) => {
            const visit = (output: unknown, round: number): Node.Node<unknown, unknown> =>
              Node.andThen(
                call(stages.review, output),
                Node.capture({ maxRounds, round }, (review) => {
                  if (accepted(review)) return Node.succeed(output)
                  if (round >= maxRounds) {
                    return Node.succeed({ output, review, approved: false, exhausted: true })
                  }
                  return Node.andThen(
                    call(stages.revise, { output, review, round }),
                    Node.capture({ maxRounds, round }, (revised) => visit(revised, round + 1))
                  )
                })
              )
            return visit(initial, 1)
          })
        )
    )
  })
}

/**
 * Executes produce-review-revise rounds and short-circuits on approval.
 *
 * This Effect is the operational value-dependent branch; the flow declaration
 * remains a conservative topology because core plans continuations against
 * symbolic values. Fiber interruption propagates normally.
 *
 * @category combinators
 * @since 0.1.0
 */
export const run = <I, A, Review, E, R, E2, R2, E3, R3>(
  input: I,
  options: RuntimeOptions<I, A, Review, E, R, E2, R2, E3, R3>
): Effect.Effect<A | Exhausted<A, Review>, E | E2 | E3 | PatternError, R | R2 | R3> => {
  // Snapshots taken at the call: the effect may run later, and a caller's
  // edit to the option object in between must not reach it.
  const stages = { produce: options.produce, review: options.review, revise: options.revise }
  const maxRounds = options.maxRounds
  if (!Number.isSafeInteger(maxRounds) || maxRounds < 1) {
    return Effect.fail(
      new PatternError({
        code: "invalid_decorator",
        message: "ReviewLoop maxRounds must be a positive safe integer"
      })
    )
  }
  return Effect.gen(function*() {
    let output = yield* stages.produce(input)
    let round = 1
    while (true) {
      const review = yield* stages.review(output, round)
      if (accepted(review)) return output
      if (round === maxRounds) {
        return { output, review, approved: false, exhausted: true }
      }
      output = yield* stages.revise({ output, review, round })
      round += 1
    }
  })
}
