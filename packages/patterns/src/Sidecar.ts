/**
 * Run a cheap shadow beside the primary and measure the gap.
 *
 * A sidecar answers one question: would the cheaper model have been good
 * enough? It runs both over the same input, concurrently, and scores them.
 * The shadow is an experiment, so its failure is quarantined and the primary
 * result stands. The primary is not: a sidecar is not a fallback ladder, and a
 * failed primary is a failed run. {@link Escalation} is the pattern for
 * alternatives.
 *
 * @see docs/reference/patterns-loops.md
 *
 * @since 0.1.0
 */
import { Flow, Node } from "@smthrs/core"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Schema from "effect/Schema"

/**
 * Configuration for {@link make}.
 *
 * Omit `score` for a sidecar that only records the shadow output for later
 * comparison.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface MakeOptions {
  readonly primary: Flow.Any
  readonly shadow: Flow.Any
  readonly score?: Flow.Any | undefined
}

/**
 * The two scores a comparison produces.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface Scores {
  readonly primary: number
  readonly shadow: number
}

/**
 * A scored comparison of the primary against its shadow.
 *
 * `difference` is `primary - shadow`, so a positive difference means the
 * expensive run was better. `cheaperWins` is the finding a sidecar exists to
 * produce: the shadow matched or beat the primary, and the cheaper seat is a
 * candidate for the real work.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface Delta extends Scores {
  readonly difference: number
  readonly cheaperWins: boolean
}

/**
 * The shadow's outcome, quarantined when it failed.
 *
 * A quarantined shadow carries its `Cause`, so an operator can read what the
 * experiment did without the run having failed. The declared form
 * ({@link make}) carries `error` instead: a recovery arm is planned against the
 * typed error the shadow may fail with, and only a running fiber has the whole
 * cause.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type Shadow<S> =
  | { readonly quarantined: false; readonly value: S }
  | { readonly quarantined: true; readonly cause: Cause.Cause<unknown> }

/**
 * The outcome of one sidecar run.
 *
 * `delta` is absent when no scorer is configured and when the shadow was
 * quarantined, because there is nothing to compare against.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface Result<P, S> {
  readonly primary: P
  readonly shadow: Shadow<S>
  readonly delta?: Delta | undefined
}

/**
 * Operational callbacks for {@link run}.
 *
 * `score` receives both outputs and is called only when the shadow produced
 * one. Its failure is the run's failure: an unreadable measurement is worse
 * than no measurement.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface RuntimeOptions<I, P, S, E, R, E2, R2, E3 = never, R3 = never> {
  readonly primary: (input: I) => Effect.Effect<P, E, R>
  readonly shadow: (input: I) => Effect.Effect<S, E2, R2>
  readonly score?:
    | ((input: { readonly primary: P; readonly shadow: S }) => Effect.Effect<Scores, E3, R3>)
    | undefined
}

const call = (flow: Flow.Any, input: unknown): Node.Node<unknown, unknown> =>
  (flow as unknown as (input: unknown) => Node.Node<unknown, unknown>)(input)

// Reads one field of a joined value. During planning the value is symbolic and
// the read answers a reference the plan records; during execution it answers
// the field. Both directions matter: the plan must show which half of the join
// the scorer reads, and the run must actually read it.
const field = (value: unknown, key: string): unknown => (value as Record<string, unknown>)[key]

/**
 * Compares two scores.
 *
 * The subtraction is rounded to twelve decimal places, because a raw
 * floating-point difference reports `0.30000000000000004` for two scores an
 * operator entered as `0.8` and `0.5`. A tie counts as `cheaperWins`: equal
 * quality at lower cost is the cheaper seat winning.
 *
 * @category combinators
 * @since 0.1.0
 * @slop
 */
export const delta = (primary: number, shadow: number): Delta => ({
  primary,
  shadow,
  difference: Number((primary - shadow).toFixed(12)),
  cheaperWins: shadow >= primary
})

/**
 * Declares the sidecar topology: primary and shadow under one `All`, with the
 * shadow behind a `Catch`.
 *
 * The declared `All` is what makes the shadow concurrent rather than an extra
 * sequential step. The `Catch` is what makes it an experiment: the arm settles
 * the shadow as `{ quarantined: true, error }`, so the join cannot fail on the
 * shadow's behalf and a plan reader sees that a failed shadow does not fail the
 * run. A settled shadow is `{ quarantined: false, value }`, the shape
 * {@link run} reports.
 *
 * The score arm is declared unconditionally, because a plan has no branch to
 * hang the "only when the shadow produced a value" condition on. `run` has the
 * value in hand and skips the scorer for a quarantined shadow. The declared
 * result is `{ primary, shadow, delta }`, which is {@link Result}.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const make = (options: MakeOptions): Flow.Flow<typeof Schema.Unknown, typeof Schema.Unknown, unknown> => {
  const score = options.score
  return Flow.make({
    input: Schema.Unknown,
    output: Schema.Unknown,
    flows: score === undefined
      ? [options.primary, options.shadow]
      : [options.primary, options.shadow, score],
    body: Node.capture({ scores: score !== undefined }, (input) => {
      const shadow: Node.Node<unknown, unknown> = Node.catch(
        Node.map(
          call(options.shadow, input),
          Node.capture({ shadow: "settled" }, (value: unknown) => ({ quarantined: false, value }))
        ),
        {
          onFailure: Node.capture(
            { shadow: "quarantined" },
            (error: unknown) => Node.succeed({ quarantined: true, error })
          )
        }
      )
      const scored = (both: unknown): Node.Node<unknown, unknown> =>
        score === undefined ? Node.succeed(both) : Node.map(
          // The scorer sees the same pair `run` hands it: the primary's value
          // and the shadow's, not the shadow's quarantine wrapper.
          call(score, { primary: field(both, "primary"), shadow: field(field(both, "shadow"), "value") }),
          Node.capture({ scores: true }, (scores: unknown) => ({
            primary: field(both, "primary"),
            shadow: field(both, "shadow"),
            delta: delta(field(scores, "primary") as number, field(scores, "shadow") as number)
          }))
        )
      return Node.andThen(
        Node.all({ primary: call(options.primary, input), shadow }),
        Node.capture({ scores: score !== undefined }, scored)
      )
    })
  })
}

/**
 * Runs the primary and its shadow concurrently and scores the pair.
 *
 * The shadow's failure, defect included, becomes a quarantined result rather
 * than a run failure. Interruption is not quarantined: a cancelled run is
 * cancelled, and reporting the shadow as merely failed would hide that.
 *
 * @category combinators
 * @since 0.1.0
 * @slop
 */
export const run = <I, P, S, E, R, E2, R2, E3 = never, R3 = never>(
  input: I,
  options: RuntimeOptions<I, P, S, E, R, E2, R2, E3, R3>
): Effect.Effect<Result<P, S>, E | E3, R | R2 | R3> =>
  Effect.gen(function*() {
    const quarantine: Effect.Effect<Shadow<S>, never, R2> = Effect.flatMap(
      Effect.exit(options.shadow(input)),
      (exit) =>
        Exit.isSuccess(exit)
          ? Effect.succeed<Shadow<S>>({ quarantined: false, value: exit.value })
          // An interrupted shadow means the run itself is being cancelled.
          // Reporting that as a quarantined experiment would hide the
          // cancellation, so re-raise it as the interruption it is.
          : Cause.hasInterrupts(exit.cause)
          ? Effect.interrupt
          : Effect.succeed<Shadow<S>>({ quarantined: true, cause: exit.cause })
    )
    const [primary, shadow] = yield* Effect.all([options.primary(input), quarantine] as const, { concurrency: 2 })
    if (options.score === undefined || shadow.quarantined) {
      const reported: Result<P, S> = { primary, shadow }
      return reported
    }
    const scores = yield* options.score({ primary, shadow: shadow.value })
    const reported: Result<P, S> = { primary, shadow, delta: delta(scores.primary, scores.shadow) }
    return reported
  })
