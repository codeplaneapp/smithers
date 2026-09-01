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
 * INCONCLUSIVE grades an environment fault, never a measurement. A gate the
 * scores actually missed is a finding and grades `Failed`, so a suite cannot
 * report an undecidable harness on evidence it did decide.
 *
 * @since 0.0.0
 */
import { Effect } from "effect"
import { type ScoreGateCode, ScoreGateError } from "./TestingError.ts"

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
 * The two kinds of bad news are separate members, because they answer
 * different questions. `Failed` is a finding: the scores a run produced did
 * not meet a gate, which is a measurement and a red. `Inconclusive` is an
 * environment fault: nothing could be measured, which is a broken harness to
 * repair rather than a result to read. A fault observed beside a decidable
 * gate travels in `inconclusive` alongside the verdict, never instead of it.
 *
 * @category models
 * @since 0.0.0
 */
export type Verdict =
  | { readonly _tag: "Passed"; readonly inconclusive: ReadonlyArray<string> }
  | {
    readonly _tag: "Failed"
    readonly reasons: ReadonlyArray<string>
    readonly inconclusive: ReadonlyArray<string>
  }
  | { readonly _tag: "Inconclusive"; readonly reasons: ReadonlyArray<string> }

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

const unique = (reasons: ReadonlyArray<string>): ReadonlyArray<string> => [...new Set(reasons)]

const faults = (samples: ReadonlyArray<ScoreSample>): ReadonlyArray<string> =>
  samples.flatMap((sample) => sample.kind === "inconclusive" ? [sample.reason] : [])

/**
 * Renders one breach with the stable code the error channel uses for misuse,
 * so a reason line names the gate, its threshold, and what the run scored.
 * Binary noise is trimmed: a mean of `0.8500000000000001` reads as `0.85`.
 */
const breach = (code: ScoreGateCode, threshold: number, actual: number): string =>
  `${code}: threshold ${Number(threshold.toPrecision(6))}, actual ${Number(actual.toPrecision(6))}`

const passed = (samples: ReadonlyArray<ScoreSample>): Extract<Verdict, { readonly _tag: "Passed" }> => ({
  _tag: "Passed",
  inconclusive: unique(faults(samples))
})

const failed = (
  samples: ReadonlyArray<ScoreSample>,
  reasons: ReadonlyArray<string>
): Extract<Verdict, { readonly _tag: "Failed" }> => ({
  _tag: "Failed",
  reasons,
  inconclusive: unique(faults(samples))
})

const undecidable = (samples: ReadonlyArray<ScoreSample>, extra: ReadonlyArray<string>): Verdict => ({
  _tag: "Inconclusive",
  reasons: unique([...faults(samples), ...extra])
})

const scoreValues = (samples: ReadonlyArray<ScoreSample>): ReadonlyArray<number> =>
  samples.flatMap((sample) => sample.kind === "score" ? [sample.value] : [])

/**
 * Reduces the verdicts of several gates, plus the environment faults observed
 * outside them, to one verdict.
 *
 * Precedence is findings first: a gate a run measurably missed is a red even
 * when another observation went missing, because the failing measurement
 * happened. A gate that could not be evaluated at all keeps the run
 * inconclusive, and faults that decided nothing travel alongside a pass.
 *
 * @category grading
 * @since 0.0.0
 */
export const combine = (
  verdicts: ReadonlyArray<Verdict>,
  environmentFaults: ReadonlyArray<string> = []
): Verdict => {
  const reasons = unique(verdicts.flatMap((verdict) => verdict._tag === "Failed" ? verdict.reasons : []))
  const undecided = unique(verdicts.flatMap((verdict) => verdict._tag === "Inconclusive" ? verdict.reasons : []))
  const observed = unique([
    ...environmentFaults,
    ...verdicts.flatMap((verdict) => verdict._tag === "Inconclusive" ? [] : verdict.inconclusive)
  ])
  if (reasons.length > 0) return { _tag: "Failed", reasons, inconclusive: unique([...observed, ...undecided]) }
  if (undecided.length > 0) return { _tag: "Inconclusive", reasons: unique([...undecided, ...observed]) }
  if (verdicts.length === 0 && observed.length > 0) return { _tag: "Inconclusive", reasons: observed }
  return { _tag: "Passed", inconclusive: observed }
}

/**
 * Maps a verdict to the shared CI convention: a finding exits 1, an
 * undecidable run exits 5, and a clean pass exits 0. A pass that carries
 * unresolved observations exits 5 as well: the gates it met were met over
 * fewer observations than the suite declared.
 *
 * @category grading
 * @since 0.0.0
 */
export const grade = (verdict: Verdict): { readonly exitCode: 0 | 1 | 5; readonly summary: string } => {
  switch (verdict._tag) {
    case "Failed":
      return {
        exitCode: 1,
        summary: `failed: ${
          [
            ...verdict.reasons,
            ...(verdict.inconclusive.length === 0 ? [] : [`unresolved: ${verdict.inconclusive.join("; ")}`])
          ].join("; ")
        }`
      }
    case "Inconclusive":
      return { exitCode: 5, summary: `inconclusive: ${verdict.reasons.join("; ")}` }
    case "Passed":
      return verdict.inconclusive.length === 0
        ? { exitCode: 0, summary: "passed" }
        : { exitCode: 5, summary: `passed every gate with unresolved: ${verdict.inconclusive.join("; ")}` }
  }
}

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
 * Builds gates over a fixed sample set.
 *
 * A gate is evaluated over the score observations that exist. An inconclusive
 * observation is an environment fault or an unavailable judge: it is reported
 * beside the verdict, and it withholds a decision only when it leaves the gate
 * nothing to measure. A gate the surviving scores miss is `Failed`, not
 * inconclusive. The error channel is reserved for misuse of the gate itself, a
 * threshold or a score outside `[0, 1]`.
 *
 * @since 0.0.0
 * @category constructors
 */
export const expectScores = (samples: ReadonlyArray<ScoreSample>): ScoreExpectation => {
  const validate = validateScores(samples)

  return {
    mean: (threshold) =>
      Effect.gen(function*() {
        yield* validateThreshold(threshold)
        yield* validate
        const values = scoreValues(samples)
        if (values.length === 0) return undecidable(samples, ["No score samples for mean gate"])
        const actual = values.reduce((total, value) => total + value, 0) / values.length
        return actual < threshold
          ? failed(samples, [breach("mean_below_threshold", threshold, actual)])
          : passed(samples)
      }),
    min: (threshold) =>
      Effect.gen(function*() {
        yield* validateThreshold(threshold)
        yield* validate
        const values = scoreValues(samples)
        if (values.length === 0) return undecidable(samples, ["No score samples for min gate"])
        const actual = Math.min(...values)
        return actual < threshold
          ? failed(samples, [breach("min_below_threshold", threshold, actual)])
          : passed(samples)
      }),
    perCase: (thresholds) =>
      Effect.gen(function*() {
        for (const threshold of Object.values(thresholds)) yield* validateThreshold(threshold)
        yield* validate
        const named = Object.entries(thresholds)
        if (named.length === 0) return passed(samples)
        const breaches: Array<string> = []
        const unmeasured: Array<string> = []
        for (const [caseName, threshold] of named) {
          const values = scoreValues(samples.filter((sample) => sample.case === caseName))
          if (values.length === 0) {
            unmeasured.push(`No score samples for case ${caseName}`)
            continue
          }
          const actual = Math.min(...values)
          if (actual < threshold) breaches.push(breach("case_below_threshold", threshold, actual))
        }
        // Every named case went unmeasured, so this gate decided nothing. One
        // unmeasured case among measured ones is reported alongside the
        // verdict the others earned.
        if (unmeasured.length === named.length) return undecidable(samples, unmeasured)
        const verdict = breaches.length === 0 ? passed(samples) : failed(samples, breaches)
        return { ...verdict, inconclusive: unique([...verdict.inconclusive, ...unmeasured]) }
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
 * applies the declared gates over the samples that exist, and grades the whole
 * run.
 *
 * A case that hit an environment fault contributes no samples and its reason
 * to the verdict's `inconclusive` list; it no longer cancels the gates the
 * finished cases can still be judged by. A gate those cases miss is `Failed`,
 * which {@link ciGrade} exits 1 on.
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
    const environmentFaults = reports.flatMap((report) =>
      report.verdict._tag === "Inconclusive" ? report.verdict.reasons : []
    )
    const expectation = expectScores(samples)
    const gates = options.gates ?? {}
    const verdicts: Array<Verdict> = []
    if (gates.mean !== undefined) verdicts.push(yield* expectation.mean(gates.mean))
    if (gates.min !== undefined) verdicts.push(yield* expectation.min(gates.min))
    const perCase = Object.fromEntries(
      options.cases.flatMap((suiteCase) =>
        suiteCase.minScore === undefined ? [] : [[suiteCase.name, suiteCase.minScore]]
      )
    )
    if (Object.keys(perCase).length > 0) verdicts.push(yield* expectation.perCase(perCase))
    return { cases: reports, samples, verdict: combine(verdicts, environmentFaults) }
  })

/**
 * The CI grading of a suite report, through {@link grade}: a clean pass exits
 * 0, a gate the run missed exits 1, and a run that could not be decided exits 5
 * (never a red), mirroring the smithers `eval` CLI contract the conversion note
 * inherits.
 *
 * @since 0.0.0
 * @category grading
 */
export const ciGrade = (report: SuiteReport): { readonly exitCode: 0 | 1 | 5; readonly summary: string } => {
  const graded = grade(report.verdict)
  return graded.exitCode === 0
    ? { exitCode: 0, summary: `passed: ${report.cases.length} case(s), ${report.samples.length} sample(s)` }
    : graded
}
