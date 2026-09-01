/**
 * The pass/fail decision over a finished evaluation run: how a threshold
 * is applied and what a failing gate reports.
 *
 * @since 0.1.0
 */
import { combine, expectScores, grade, type ScoreSample, type Verdict } from "@smthrs/testing/ScoreGate"
import type { ScoreGateError } from "@smthrs/testing/TestingError"
import * as Effect from "effect/Effect"
import type { Report } from "./Regression.ts"

/**
 * Thresholds accepted by a CI score gate.
 *
 * @see docs/specs/Concepts/Scoring.md
 * @since 0.1.0
 * @category models
 * @slop
 */
export interface Options {
  readonly mean?: number | undefined
  readonly min?: number | undefined
  readonly perCase?: Readonly<Record<string, number>> | undefined
}

const samples = (report: Report): ReadonlyArray<ScoreSample> =>
  report.run.observations.map((observation) =>
    observation.kind === "score"
      ? {
        case: observation.case,
        scorer: observation.scorer,
        stepKey: observation.stepKey,
        kind: "score",
        value: observation.score,
        reason: observation.reason
      }
      : {
        case: observation.case,
        scorer: observation.scorer,
        stepKey: observation.stepKey,
        kind: "inconclusive",
        reason: observation.reason
      }
  )

/**
 * An environment fault: something the comparison needed was never observed, so
 * the harness owes an answer it cannot give. A fault withholds a decision;
 * it does not make one.
 */
const environmentFaults = (report: Report): ReadonlyArray<string> => [
  ...report.run.cases.flatMap((result) =>
    result.error === undefined ? [] : [`case '${result.case}' failed: ${result.error.message}`]
  ),
  ...report.missing.map((item) => `missing ${item.side} observation for ${item.case}/${item.scorer}/${item.stepKey}`)
]

/**
 * A finding: the run measured something the baseline says it should not have.
 * A regression scored lower at a changed step key, and nondeterminism moved a
 * score at an unchanged one. Both are results, so both are red.
 */
const findings = (report: Report): ReadonlyArray<string> => [
  ...report.regressions.map((item) => `regression for ${item.case}/${item.scorer}`),
  ...report.nondeterminism.map((item) => `nondeterminism for ${item.case}/${item.scorer}`)
]

/**
 * Checks thresholds through `/testing`'s shared ScoreGate arithmetic.
 *
 * The threshold gates always run: an unobserved case cannot excuse the cases
 * that were observed. Faults and findings are kept apart, and the verdict
 * carries both, so a regression is a red while an unusable harness stays
 * undecided.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const check = (report: Report, options: Options = {}): Effect.Effect<Verdict, ScoreGateError> =>
  Effect.gen(function*() {
    const expectation = expectScores(samples(report))
    const verdicts: Array<Verdict> = []
    if (options.mean !== undefined) verdicts.push(yield* expectation.mean(options.mean))
    if (options.min !== undefined) verdicts.push(yield* expectation.min(options.min))
    if (options.perCase !== undefined) verdicts.push(yield* expectation.perCase(options.perCase))
    if (options.mean === undefined && options.min === undefined && options.perCase === undefined) {
      verdicts.push(yield* expectation.mean(0))
    }
    const reasons = findings(report)
    if (reasons.length > 0) verdicts.push({ _tag: "Failed", reasons, inconclusive: [] })
    return combine(verdicts, environmentFaults(report))
  })

/**
 * Maps a gate verdict to the shared CI convention: a finding is exit code 1,
 * an undecidable run is exit code 5.
 *
 * @category grading
 * @since 0.1.0
 * @slop
 */
export const ciGrade = (verdict: Verdict): { readonly exitCode: 0 | 1 | 5; readonly summary: string } => grade(verdict)
