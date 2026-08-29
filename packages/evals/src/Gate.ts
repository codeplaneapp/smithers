/**
 * The pass/fail decision over a finished evaluation run: how a threshold
 * is applied and what a failing gate reports.
 *
 * @since 0.1.0
 */
import { expectScores, type ScoreSample, type Verdict } from "@smthrs/testing/ScoreGate"
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
 * Checks thresholds through `/testing`'s shared ScoreGate arithmetic.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const check = (report: Report, options: Options = {}): Effect.Effect<Verdict, ScoreGateError> =>
  Effect.gen(function*() {
    const runFailures = report.run.cases.flatMap((result) =>
      result.error === undefined ? [] : [`case '${result.case}' failed: ${result.error.message}`]
    )
    const auditFailures = [
      ...report.missing.map((item) =>
        `missing ${item.side} observation for ${item.case}/${item.scorer}/${item.stepKey}`
      ),
      ...report.regressions.map((item) => `regression for ${item.case}/${item.scorer}`),
      ...report.nondeterminism.map((item) => `nondeterminism for ${item.case}/${item.scorer}`)
    ]
    if (runFailures.length > 0 || auditFailures.length > 0) {
      return { _tag: "Inconclusive", reasons: [...runFailures, ...auditFailures] }
    }
    const expectation = expectScores(samples(report))
    let result: Verdict = { _tag: "Passed" }
    const merge = (next: Verdict): void => {
      if (next._tag === "Inconclusive") {
        result = result._tag === "Passed"
          ? next
          : { _tag: "Inconclusive", reasons: [...result.reasons, ...next.reasons] }
      }
    }
    if (options.mean !== undefined) merge(yield* expectation.mean(options.mean))
    if (options.min !== undefined) merge(yield* expectation.min(options.min))
    if (options.perCase !== undefined) merge(yield* expectation.perCase(options.perCase))
    if (options.mean === undefined && options.min === undefined && options.perCase === undefined) {
      merge(yield* expectation.mean(0))
    }
    return result
  })

/**
 * Maps a gate verdict to the shared CI convention: inconclusive is exit code 5.
 *
 * @category grading
 * @since 0.1.0
 * @slop
 */
export const ciGrade = (verdict: Verdict): { readonly exitCode: 0 | 5; readonly summary: string } =>
  verdict._tag === "Passed"
    ? { exitCode: 0, summary: "passed" }
    : { exitCode: 5, summary: `inconclusive: ${verdict.reasons.join("; ")}` }
