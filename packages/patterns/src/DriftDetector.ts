/**
 * Capture the world, compare it to a baseline, and alert when it moved.
 *
 * Drift detection is the shape behind config auditing, index freshness, and
 * dependency pinning: one capture, one comparison against a remembered state,
 * and an action taken only when the comparison says something changed.
 *
 * The pattern detects once. Polling belongs to the caller, because how often
 * to look is a deployment decision rather than a property of the check: wrap
 * {@link run} in `Loop.run` for rounds inside one execution, or hand it to a
 * `@smthrs/triggers` schedule for rounds the control plane owns. The recipe is
 * in `docs/pages/api/patterns-loops.md`.
 *
 * @see docs/pages/api/patterns-loops.md
 *
 * @since 0.1.0
 */
import { Flow, Node } from "@smthrs/core"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

/**
 * Configuration for {@link make}.
 *
 * `baseline` is the remembered state every capture is compared against. It is
 * a declared literal, so two detectors watching the same target against
 * different baselines do not share a step key.
 *
 * Omit `alert` for a detector that only reports. Supplying one declares the
 * alert call unconditionally: whether a run takes it depends on the
 * comparison, which no plan can know.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface MakeOptions {
  readonly capture: Flow.Any
  readonly compare: Flow.Any
  readonly alert?: Flow.Any | undefined
  readonly baseline: unknown
}

/**
 * Operational callbacks for {@link run}.
 *
 * `alertIf` replaces the default {@link drifted} reader for a comparison that
 * reports a magnitude rather than a verdict, such as a numeric delta against a
 * tolerance.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface RuntimeOptions<I, Baseline, Snapshot, Comparison, Alert, E, R, E2, R2, E3 = never, R3 = never> {
  readonly baseline: Baseline
  readonly capture: (input: {
    readonly input: I
    readonly baseline: Baseline
  }) => Effect.Effect<Snapshot, E, R>
  readonly compare: (input: {
    readonly snapshot: Snapshot
    readonly baseline: Baseline
  }) => Effect.Effect<Comparison, E2, R2>
  readonly alertIf?: ((comparison: Comparison) => boolean) | undefined
  readonly alert?:
    | ((input: {
      readonly comparison: Comparison
      readonly snapshot: Snapshot
      readonly baseline: Baseline
    }) => Effect.Effect<Alert, E3, R3>)
    | undefined
}

/**
 * The outcome of one detection.
 *
 * `alert` is absent when nothing drifted and when no alert is configured, so a
 * present `alert` proves the action ran.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface Result<Snapshot, Comparison, Alert> {
  readonly snapshot: Snapshot
  readonly comparison: Comparison
  readonly drifted: boolean
  readonly alert?: Alert | undefined
}

const call = (flow: Flow.Any, input: unknown): Node.Node<unknown, unknown> =>
  (flow as unknown as (input: unknown) => Node.Node<unknown, unknown>)(input)

/**
 * Reads the drift signals a comparison may carry.
 *
 * A comparison answers with `true` or an object carrying `drifted: true`.
 * Anything else reads as no drift, so a comparison that reports a magnitude
 * needs `RuntimeOptions.alertIf` instead.
 *
 * @category predicates
 * @since 0.1.0
 * @slop
 */
export const drifted = (value: unknown): boolean =>
  value === true ||
  (typeof value === "object" && value !== null && "drifted" in value && value.drifted === true)

/**
 * Declares the detection topology: capture, compare, and the alert arm.
 *
 * The alert call is declared whenever an alert flow is supplied. Core plans a
 * body by evaluating builders once against symbolic values, so a declaration
 * cannot branch on the comparison; declaring the alert is the conservative
 * answer, and capability analysis sees the paging authority a run may use.
 * {@link run} performs the real skip.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const make = (options: MakeOptions): Flow.Flow<typeof Schema.Unknown, typeof Schema.Unknown, unknown> => {
  const alert = options.alert
  return Flow.make({
    input: Schema.Unknown,
    output: Schema.Unknown,
    flows: alert === undefined ? [options.capture, options.compare] : [options.capture, options.compare, alert],
    body: Node.capture({ baseline: options.baseline, alerts: alert !== undefined }, (input) =>
      Node.andThen(
        call(options.capture, { input, baseline: options.baseline }),
        Node.capture({ baseline: options.baseline }, (snapshot) =>
          Node.andThen(
            call(options.compare, { snapshot, baseline: options.baseline }),
            Node.capture({ baseline: options.baseline }, (comparison) =>
              alert === undefined
                ? Node.succeed({ snapshot, comparison })
                : Node.map(
                  call(alert, { comparison, snapshot, baseline: options.baseline }),
                  Node.capture({ baseline: options.baseline }, (raised) => ({ snapshot, comparison, alert: raised }))
                ))
          ))
      ))
  })
}

/**
 * Captures, compares, and alerts only when the comparison reports drift.
 *
 * The alert runs at most once per detection. Its failure is the run's failure:
 * a detector that cannot page has not detected anything an operator will see.
 *
 * @category combinators
 * @since 0.1.0
 * @slop
 */
export const run = <I, Baseline, Snapshot, Comparison, Alert, E, R, E2, R2, E3 = never, R3 = never>(
  input: I,
  options: RuntimeOptions<I, Baseline, Snapshot, Comparison, Alert, E, R, E2, R2, E3, R3>
): Effect.Effect<Result<Snapshot, Comparison, Alert>, E | E2 | E3, R | R2 | R3> =>
  Effect.gen(function*() {
    const baseline = options.baseline
    const snapshot = yield* options.capture({ input, baseline })
    const comparison = yield* options.compare({ snapshot, baseline })
    const moved = options.alertIf === undefined ? drifted(comparison) : options.alertIf(comparison)
    if (!moved || options.alert === undefined) {
      return { snapshot, comparison, drifted: moved }
    }
    const raised = yield* options.alert({ comparison, snapshot, baseline })
    return { snapshot, comparison, drifted: moved, alert: raised }
  })
