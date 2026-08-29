/**
 * Fixed-suite score gates and the graded suite runner.
 *
 * Live production observations intentionally do not enter this module: a gate
 * is evaluated only over its caller-owned, fixed sample array. Contract
 * sources: `docs/specs/Research/Smithers Testing Library Conversion
 * 2026-07-27.md` §3 sketch 6 (the `suite()` value with score gates and
 * INCONCLUSIVE grading) and the vitest-evals harness prior art at
 * `reference/flue/blueprints/tooling--vitest-evals.md` (per-case runner +
 * reporter split). The case-runner is caller-supplied until the flow runtime
 * lands; scorer samples flow through it unchanged.
 *
 * @since 0.0.0
 */
import { Effect } from "effect"
import { ScoreGateError } from "./TestingError.ts"

/**
 * A score observation collected for one fixed test case and step key.
 *
 * @category models
 * @since 0.0.0
 */
export type ScoreSample =
  & {
    readonly case: string
    readonly stepKey: string
    readonly scorer: string
  }
  & (
    | { readonly kind: "score"; readonly value: number; readonly reason?: string | undefined }
    | { readonly kind: "inconclusive"; readonly reason: string }
  )

/**
 * The non-error result of grading a fixed suite.
 *
 * @category models
 * @since 0.0.0
 */
export type Verdict =
  | { readonly _tag: "Passed" }
  | { readonly _tag: "Inconclusive"; readonly reasons: ReadonlyArray<string> }

const passed: Verdict = { _tag: "Passed" }

const invalidThreshold = (threshold: number): Effect.Effect<never, ScoreGateError> =>
  Effect.fail(new ScoreGateError({ code: "invalid_threshold", threshold, actual: threshold }))

const validateThreshold = (threshold: number): Effect.Effect<void, ScoreGateError> =>
  Number.isFinite(threshold) && threshold >= 0 && threshold <= 1
    ? Effect.void
    : invalidThreshold(threshold)

const validateScores = (samples: ReadonlyArray<ScoreSample>): Effect.Effect<void, ScoreGateError> => {
  for (const sample of samples) {
    if (sample.kind === "score" && (!Number.isFinite(sample.value) || sample.value < 0 || sample.value > 1)) {
      return Effect.fail(new ScoreGateError({ code: "invalid_score", threshold: 0, actual: sample.value }))
    }
  }
  return Effect.void
}

const inconclusive = (samples: ReadonlyArray<ScoreSample>, extra: ReadonlyArray<string> = []): Verdict | undefined => {
  const reasons = [
    ...samples.flatMap((sample) => sample.kind === "inconclusive" ? [sample.reason] : []),
    ...extra
  ]
  return reasons.length === 0 ? undefined : { _tag: "Inconclusive", reasons }
}

const scoreValues = (samples: ReadonlyArray<ScoreSample>): ReadonlyArray<number> =>
  samples.flatMap((sample) => sample.kind === "score" ? [sample.value] : [])

/**
 * A fixed-suite score-gate builder.
 *
 * @category constructors
 * @since 0.0.0
 */
export interface ScoreExpectation {
  /** Requires the arithmetic mean of all score observations to meet `threshold`. @since 0.0.0 @category gates */
  readonly mean: (threshold: number) => Effect.Effect<Verdict, ScoreGateError>
  /** Requires every score observation to meet `threshold`. @since 0.0.0 @category gates */
  readonly min: (threshold: number) => Effect.Effect<Verdict, ScoreGateError>
  /** Requires every named case's lowest score observation to meet its threshold. @since 0.0.0 @category gates */
  readonly perCase: (thresholds: Readonly<Record<string, number>>) => Effect.Effect<Verdict, ScoreGateError>
}

/**
 * Builds gates over a fixed sample set. Inconclusive observations represent an
 * environment fault or unavailable judge and grade the suite Inconclusive,
 * never as a failed score gate.
 *
 * @since 0.0.0
 * @category constructors
 */
export const expectScores = (samples: ReadonlyArray<ScoreSample>): ScoreExpectation => {
  const validate = validateScores(samples)
  const noScores = (label: string): Verdict | undefined =>
    scoreValues(samples).length === 0 ? inconclusive(samples, [`No score samples for ${label}`]) : inconclusive(samples)

  return {
    mean: (threshold) =>
      Effect.gen(function*() {
        yield* validateThreshold(threshold)
        yield* validate
        const verdict = noScores("mean gate")
        if (verdict !== undefined) return verdict
        const values = scoreValues(samples)
        const actual = values.reduce((total, value) => total + value, 0) / values.length
        if (actual < threshold) {
          return yield* Effect.fail(new ScoreGateError({ code: "mean_below_threshold", threshold, actual }))
        }
        return passed
      }),
    min: (threshold) =>
      Effect.gen(function*() {
        yield* validateThreshold(threshold)
        yield* validate
        const verdict = noScores("min gate")
        if (verdict !== undefined) return verdict
        const actual = Math.min(...scoreValues(samples))
        if (actual < threshold) {
          return yield* Effect.fail(new ScoreGateError({ code: "min_below_threshold", threshold, actual }))
        }
        return passed
      }),
    perCase: (thresholds) =>
      Effect.gen(function*() {
        for (const threshold of Object.values(thresholds)) yield* validateThreshold(threshold)
        yield* validate
        const inconclusiveSamples = inconclusive(samples)
        if (inconclusiveSamples !== undefined) return inconclusiveSamples
        for (const [caseName, threshold] of Object.entries(thresholds)) {
          const values = scoreValues(samples.filter((sample) => sample.case === caseName))
          if (values.length === 0) return { _tag: "Inconclusive", reasons: [`No score samples for case ${caseName}`] }
          const actual = Math.min(...values)
          if (actual < threshold) {
            return yield* Effect.fail(new ScoreGateError({ code: "case_below_threshold", threshold, actual }))
          }
        }
        return passed
      })
  }
}

/**
 * One fixed suite case: a name, its input, and optional score gates scoped to
 * this case only.
 *
 * @since 0.0.0
 * @category models
 */
export interface SuiteCase<I> {
  readonly name: string
  readonly input: I
  /** Per-case minimum applied through the `perCase` gate. */
  readonly minScore?: number | undefined
}

/**
 * Gates applied across the whole fixed suite.
 *
 * @since 0.0.0
 * @category models
 */
export interface SuiteGates {
  readonly mean?: number | undefined
  readonly min?: number | undefined
}

/**
 * The graded outcome of one case.
 *
 * @since 0.0.0
 * @category models
 */
export interface CaseReport {
  readonly name: string
  readonly verdict: CaseVerdict
  readonly samples: ReadonlyArray<ScoreSample>
}

/**
 * A per-case verdict. Environment faults — a case-runner failure or defect —
 * grade `Inconclusive`, never `Failed`: the smithers `eval` lesson.
 *
 * @since 0.0.0
 * @category models
 */
export type CaseVerdict =
  | { readonly _tag: "Scored" }
  | { readonly _tag: "Inconclusive"; readonly reasons: ReadonlyArray<string> }

/**
 * The full graded report of a fixed suite run.
 *
 * @since 0.0.0
 * @category models
 */
export interface SuiteReport {
  readonly cases: ReadonlyArray<CaseReport>
  readonly samples: ReadonlyArray<ScoreSample>
  readonly verdict: Verdict
}

/**
 * Options for {@link suite}. The `run` case-runner is caller-supplied: it
 * executes one case and returns the score samples the case's scorers
 * observed. Any failure or defect it raises is an environment fault and
 * grades that case `Inconclusive`.
 *
 * @since 0.0.0
 * @category models
 */
export interface SuiteOptions<I> {
  readonly cases: ReadonlyArray<SuiteCase<I>>
  readonly run: (suiteCase: SuiteCase<I>) => Effect.Effect<ReadonlyArray<ScoreSample>, unknown>
  readonly gates?: SuiteGates | undefined
}

/**
 * Runs a fixed suite through its case-runner, collects every score sample,
 * applies the declared gates, and grades the whole run.
 *
 * A gate miss fails with `ScoreGateError`. Environment faults grade
 * `Inconclusive`, never failed.
 *
 * @since 0.0.0
 * @category constructors
 */
export const suite = <I>(options: SuiteOptions<I>): Effect.Effect<SuiteReport, ScoreGateError> =>
  Effect.gen(function*() {
    const reports: Array<CaseReport> = []
    for (const suiteCase of options.cases) {
      const exit = yield* Effect.exit(options.run(suiteCase))
      if (exit._tag === "Success") {
        reports.push({ name: suiteCase.name, verdict: { _tag: "Scored" }, samples: exit.value })
      } else {
        reports.push({
          name: suiteCase.name,
          verdict: {
            _tag: "Inconclusive",
            reasons: [`Case '${suiteCase.name}' hit an environment fault: ${String(exit.cause)}`]
          },
          samples: []
        })
      }
    }
    const samples = reports.flatMap((report) => report.samples)
    const inconclusiveReasons = reports.flatMap((report) =>
      report.verdict._tag === "Inconclusive" ? report.verdict.reasons : []
    )
    if (inconclusiveReasons.length > 0) {
      return { cases: reports, samples, verdict: { _tag: "Inconclusive", reasons: inconclusiveReasons } }
    }
    const expectation = expectScores(samples)
    let verdict: Verdict = { _tag: "Passed" }
    const merge = (next: Verdict): void => {
      if (next._tag === "Inconclusive") {
        verdict = verdict._tag === "Inconclusive"
          ? { _tag: "Inconclusive", reasons: [...verdict.reasons, ...next.reasons] }
          : next
      }
    }
    const gates = options.gates ?? {}
    if (gates.mean !== undefined) merge(yield* expectation.mean(gates.mean))
    if (gates.min !== undefined) merge(yield* expectation.min(gates.min))
    const perCase = Object.fromEntries(
      options.cases.flatMap((suiteCase) =>
        suiteCase.minScore === undefined ? [] : [[suiteCase.name, suiteCase.minScore]]
      )
    )
    if (Object.keys(perCase).length > 0) merge(yield* expectation.perCase(perCase))
    return { cases: reports, samples, verdict }
  })

/**
 * The CI grading of a suite report: pass exits 0, an inconclusive run exits 5
 * (never a red), mirroring the smithers `eval` CLI contract the conversion
 * note inherits. Gate misses never reach this function — they fail `suite`
 * with `ScoreGateError` and CI reports the typed error.
 *
 * @since 0.0.0
 * @category grading
 */
export const ciGrade = (report: SuiteReport): { readonly exitCode: 0 | 5; readonly summary: string } =>
  report.verdict._tag === "Passed"
    ? { exitCode: 0, summary: `passed: ${report.cases.length} case(s), ${report.samples.length} sample(s)` }
    : { exitCode: 5, summary: `inconclusive: ${report.verdict.reasons.join("; ")}` }
