/**
 * Step-key-aware evaluation regression comparison.
 *
 * @see docs/specs/Concepts/Scoring.md
 * @since 0.1.0
 */
import * as Effect from "effect/Effect"
import type { Baseline, Record as BaselineRecord } from "./Baseline.ts"
import { EvalError } from "./EvalError.ts"
import type { Observation, RunResult } from "./Runner.ts"

/**
 * Tolerances used for score comparisons.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface Tolerances {
  readonly absolute?: number | undefined
  readonly relative?: number | undefined
}

/**
 * A score drop at a changed step key.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface Regression {
  readonly case: string
  readonly scorer: string
  readonly baseline: BaselineRecord
  readonly actual: Extract<Observation, { readonly kind: "score" }>
  readonly drop: number
}

/**
 * A changed score at the same step key, indicating nondeterminism.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface Nondeterminism {
  readonly case: string
  readonly scorer: string
  readonly baseline: BaselineRecord
  readonly actual: Extract<Observation, { readonly kind: "score" }>
  readonly delta: number
}

/**
 * An observation present on only one side of a comparison.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface MissingObservation {
  readonly side: "baseline" | "run"
  readonly case: string
  readonly scorer: string
  readonly stepKey?: string | undefined
}

/**
 * Complete regression comparison.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface Report {
  readonly suite: string
  readonly baseline: Baseline
  readonly run: RunResult
  readonly regressions: ReadonlyArray<Regression>
  readonly nondeterminism: ReadonlyArray<Nondeterminism>
  readonly missing: ReadonlyArray<MissingObservation>
  readonly samples: ReadonlyArray<Observation>
  readonly inconclusive: ReadonlyArray<Observation>
}

const key = (caseName: string, scorer: string): string => `${caseName}\u0000${scorer}`
const validTolerance = (value: number): boolean => Number.isFinite(value) && value >= 0
const compareText = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0

/**
 * Compares a run to a baseline, preserving missing and inconclusive observations.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const compare = (
  baseline: Baseline,
  run: RunResult,
  tolerances: Tolerances = {}
): Effect.Effect<Report, EvalError> => {
  const absolute = tolerances.absolute ?? 0
  const relative = tolerances.relative ?? 0
  if (!validTolerance(absolute) || !validTolerance(relative)) {
    return Effect.fail(
      new EvalError({ code: "invalid_baseline", message: "Regression tolerances must be finite and non-negative" })
    )
  }
  const actual = run.observations.filter((
    observation
  ): observation is Extract<Observation, { readonly kind: "score" }> => observation.kind === "score")
  const inconclusive = run.observations.filter((
    observation
  ): observation is Extract<Observation, { readonly kind: "inconclusive" }> => observation.kind === "inconclusive")
  const baselineByKey = new Map<string, Array<BaselineRecord>>()
  const actualByKey = new Map<string, Array<Extract<Observation, { readonly kind: "score" }>>>()
  for (const record of baseline.records) {
    ;(baselineByKey.get(key(record.case, record.scorer)) ??
      baselineByKey.set(key(record.case, record.scorer), []).get(key(record.case, record.scorer))!).push(record)
  }
  for (const observation of actual) {
    ;(actualByKey.get(key(observation.case, observation.scorer)) ??
      actualByKey.set(key(observation.case, observation.scorer), []).get(key(observation.case, observation.scorer))!)
      .push(observation)
  }
  const regressions: Array<Regression> = []
  const nondeterminism: Array<Nondeterminism> = []
  const missing: Array<MissingObservation> = []
  const keys = new Set([...baselineByKey.keys(), ...actualByKey.keys()])
  for (const groupedKey of keys) {
    const expected = [...baselineByKey.get(groupedKey) ?? []]
    const observed = [...actualByKey.get(groupedKey) ?? []]
    const pairs: Array<
      readonly [BaselineRecord | undefined, Extract<Observation, { readonly kind: "score" }> | undefined]
    > = []
    for (const stepKey of [...new Set(expected.map((record) => record.stepKey))].sort(compareText)) {
      const expectedAtStep = expected.filter((record) => record.stepKey === stepKey).sort((a, b) => a.score - b.score)
      const observedAtStep = observed.filter((record) => record.stepKey === stepKey).sort((a, b) => a.score - b.score)
      const count = Math.min(expectedAtStep.length, observedAtStep.length)
      for (let index = 0; index < count; index++) pairs.push([expectedAtStep[index], observedAtStep[index]])
      for (let index = 0; index < count; index++) {
        expected.splice(expected.indexOf(expectedAtStep[index]!), 1)
        observed.splice(observed.indexOf(observedAtStep[index]!), 1)
      }
    }
    expected.sort((a, b) => compareText(a.stepKey, b.stepKey) || a.score - b.score)
    observed.sort((a, b) => compareText(a.stepKey, b.stepKey) || a.score - b.score)
    const count = Math.max(expected.length, observed.length)
    for (let index = 0; index < count; index++) pairs.push([expected[index], observed[index]])
    for (const [baselineRecord, observation] of pairs) {
      if (baselineRecord === undefined) {
        if (observation !== undefined) {
          missing.push({
            side: "baseline",
            case: observation.case,
            scorer: observation.scorer,
            stepKey: observation.stepKey
          })
        }
        continue
      }
      if (observation === undefined) {
        missing.push({
          side: "run",
          case: baselineRecord.case,
          scorer: baselineRecord.scorer,
          stepKey: baselineRecord.stepKey
        })
        continue
      }
      const delta = observation.score - baselineRecord.score
      if (observation.stepKey === baselineRecord.stepKey) {
        if (
          Math.abs(delta) > absolute && Math.abs(delta) / Math.max(Math.abs(baselineRecord.score), 1e-12) > relative
        ) {
          nondeterminism.push({
            case: observation.case,
            scorer: observation.scorer,
            baseline: baselineRecord,
            actual: observation,
            delta
          })
        }
      } else if (
        delta < 0 && -delta > absolute && (baselineRecord.score === 0 || -delta / baselineRecord.score > relative)
      ) {
        regressions.push({
          case: observation.case,
          scorer: observation.scorer,
          baseline: baselineRecord,
          actual: observation,
          drop: -delta
        })
      }
    }
  }
  return Effect.succeed({
    suite: run.suite,
    baseline,
    run,
    regressions,
    nondeterminism,
    missing,
    samples: actual,
    inconclusive
  })
}

/**
 * Alias for {@link compare}.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const check = compare
