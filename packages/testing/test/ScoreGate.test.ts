import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import * as ScoreGate from "../src/ScoreGate.ts"
import { ScoreGateError } from "../src/TestingError.ts"

const samples: ReadonlyArray<ScoreGate.ScoreSample> = [
  { case: "first", stepKey: "first-key", scorer: "quality", kind: "score", value: 0.9 },
  { case: "second", stepKey: "second-key", scorer: "quality", kind: "score", value: 0.8 }
]

const expectFailure = async (
  effect: Effect.Effect<unknown, ScoreGateError>,
  code: string,
  threshold: number,
  actual: number
) => {
  const error = await Effect.runPromise(effect.pipe(Effect.flip))
  expect(error).toBeInstanceOf(ScoreGateError)
  expect(error.code).toBe(code)
  expect(error.threshold).toBe(threshold)
  if (Number.isNaN(actual)) expect(Number.isNaN(error.actual)).toBe(true)
  else expect(error.actual).toBeCloseTo(actual)
}

// A gate the scores missed is a finding in the success channel, not a raised
// error: the report has to survive it.
const expectMiss = async (effect: Effect.Effect<ScoreGate.Verdict, ScoreGateError>, reason: string) => {
  expect(await Effect.runPromise(effect)).toMatchObject({ _tag: "Failed", reasons: [reason] })
}

describe("ScoreGate", () => {
  it("passes mean, minimum, and per-case gates", async () => {
    const clean = { _tag: "Passed", inconclusive: [] }
    await expect(Effect.runPromise(ScoreGate.expectScores(samples).mean(0.8))).resolves.toEqual(clean)
    await expect(Effect.runPromise(ScoreGate.expectScores(samples).min(0.8))).resolves.toEqual(clean)
    await expect(Effect.runPromise(ScoreGate.expectScores(samples).perCase({ first: 0.9, second: 0.8 }))).resolves
      .toEqual(clean)
  })

  it("reports a mean threshold miss", async () => {
    await expectMiss(ScoreGate.expectScores(samples).mean(0.86), "mean_below_threshold: threshold 0.86, actual 0.85")
  })

  it("reports a minimum threshold miss", async () => {
    await expectMiss(ScoreGate.expectScores(samples).min(0.85), "min_below_threshold: threshold 0.85, actual 0.8")
  })

  it("reports a per-case threshold miss", async () => {
    await expectMiss(
      ScoreGate.expectScores(samples).perCase({ second: 0.85 }),
      "case_below_threshold: threshold 0.85, actual 0.8"
    )
  })

  it("grades inconclusive observations without turning them into score failures", async () => {
    const verdict = await Effect.runPromise(
      ScoreGate.expectScores([
        { case: "first", stepKey: "first-key", scorer: "quality", kind: "inconclusive", reason: "judge unavailable" }
      ]).mean(0.9)
    )
    expect(verdict).toEqual({ _tag: "Inconclusive", reasons: ["judge unavailable", "No score samples for mean gate"] })
  })

  // One unavailable judge used to disable every gate: the early return fired
  // before the arithmetic ran, so 99 good scores went ungated.
  it("evaluates gates over the scores that exist and reports the fault alongside", async () => {
    const withFault: ReadonlyArray<ScoreGate.ScoreSample> = [
      ...samples,
      { case: "third", stepKey: "third-key", scorer: "quality", kind: "inconclusive", reason: "judge unavailable" }
    ]
    await expect(Effect.runPromise(ScoreGate.expectScores(withFault).mean(0.8))).resolves.toEqual({
      _tag: "Passed",
      inconclusive: ["judge unavailable"]
    })
    await expect(Effect.runPromise(ScoreGate.expectScores(withFault).min(0.7))).resolves.toEqual({
      _tag: "Passed",
      inconclusive: ["judge unavailable"]
    })
  })

  it("fails a gate the surviving scores miss instead of grading it inconclusive", async () => {
    const withFault: ReadonlyArray<ScoreGate.ScoreSample> = [
      ...samples,
      { case: "third", stepKey: "third-key", scorer: "quality", kind: "inconclusive", reason: "judge unavailable" }
    ]
    await expect(Effect.runPromise(ScoreGate.expectScores(withFault).mean(0.95))).resolves.toEqual({
      _tag: "Failed",
      reasons: ["mean_below_threshold: threshold 0.95, actual 0.85"],
      inconclusive: ["judge unavailable"]
    })
    await expect(Effect.runPromise(ScoreGate.expectScores(withFault).perCase({ second: 0.85 }))).resolves
      .toMatchObject({
        _tag: "Failed",
        reasons: ["case_below_threshold: threshold 0.85, actual 0.8"]
      })
  })

  it("rejects invalid scores", async () => {
    await expectFailure(
      ScoreGate.expectScores([{
        case: "first",
        stepKey: "first-key",
        scorer: "quality",
        kind: "score",
        value: Number.NaN
      }]).mean(0.5),
      "invalid_score",
      0,
      Number.NaN
    )
  })

  it("rejects invalid thresholds", async () => {
    await expectFailure(ScoreGate.expectScores(samples).mean(1.1), "invalid_threshold", 1.1, 1.1)
    await expectFailure(ScoreGate.expectScores(samples).min(Number.NaN), "invalid_threshold", Number.NaN, Number.NaN)
    await expectFailure(ScoreGate.expectScores(samples).perCase({ first: -0.1 }), "invalid_threshold", -0.1, -0.1)
  })
})

describe("ScoreGate.suite", () => {
  const cases: ReadonlyArray<ScoreGate.SuiteCase<string>> = [
    { name: "first", input: "a", minScore: 0.7 },
    { name: "second", input: "b" }
  ]
  const sampleFor = (name: string, value: number): ScoreGate.ScoreSample => ({
    case: name,
    stepKey: `${name}-key`,
    scorer: "quality",
    kind: "score",
    value
  })

  it("runs every case, applies gates, and passes", async () => {
    const report = await Effect.runPromise(
      ScoreGate.suite({
        cases,
        run: (suiteCase) => Effect.succeed([sampleFor(suiteCase.name, 0.9)]),
        gates: { mean: 0.8, min: 0.7 }
      })
    )
    expect(report.verdict).toEqual({ _tag: "Passed", inconclusive: [] })
    expect(report.cases).toHaveLength(2)
    expect(report.samples).toHaveLength(2)
    expect(ScoreGate.ciGrade(report).exitCode).toBe(0)
  })

  it("reports a gate miss as a failed verdict on a complete report", async () => {
    const report = await Effect.runPromise(
      ScoreGate.suite({
        cases,
        run: (suiteCase) => Effect.succeed([sampleFor(suiteCase.name, 0.6)]),
        gates: { mean: 0.8 }
      })
    )
    // Every declared gate is reported, not just the first one to break.
    expect(report.verdict).toMatchObject({
      _tag: "Failed",
      reasons: [
        "mean_below_threshold: threshold 0.8, actual 0.6",
        "case_below_threshold: threshold 0.7, actual 0.6"
      ]
    })
    expect(report.cases).toHaveLength(2)
    expect(ScoreGate.ciGrade(report).exitCode).toBe(1)
  })

  it("still raises a typed error when a threshold is misused", async () => {
    const error = await Effect.runPromise(
      ScoreGate.suite({
        cases,
        run: (suiteCase) => Effect.succeed([sampleFor(suiteCase.name, 0.6)]),
        gates: { mean: 42 }
      }).pipe(Effect.flip)
    )
    expect(error).toBeInstanceOf(ScoreGateError)
    expect(error.code).toBe("invalid_threshold")
  })

  // One environment fault used to return before the gates were built, so a
  // suite whose every finished case scored far below its gate reported
  // "inconclusive" and CI read exit 5 rather than a red.
  it("fails the suite the finished cases missed, and still reports the fault", async () => {
    const many = Array.from({ length: 49 }, (_, index) => ({ name: `case-${index}`, input: "a" }))
    const report = await Effect.runPromise(
      ScoreGate.suite({
        cases: [...many, { name: "unavailable", input: "b" }],
        run: (suiteCase) =>
          suiteCase.name === "unavailable"
            ? Effect.fail(new Error("judge unavailable"))
            : Effect.succeed([sampleFor(suiteCase.name, 0.1)]),
        gates: { mean: 0.9 }
      })
    )
    expect(report.verdict._tag).toBe("Failed")
    expect(report.samples).toHaveLength(49)
    const grade = ScoreGate.ciGrade(report)
    expect(grade.exitCode).toBe(1)
    expect(grade.summary).toContain("mean_below_threshold")
    expect(grade.summary).toContain("judge unavailable")
  })

  // Nothing was measured here, so there is no finding to report: an unusable
  // harness stays exit 5.
  it("grades environment faults inconclusive with CI exit code 5, never failed", async () => {
    const report = await Effect.runPromise(
      ScoreGate.suite({
        cases,
        run: () => Effect.fail(new Error("judge unavailable")),
        gates: { mean: 0.99 }
      })
    )
    expect(report.verdict._tag).toBe("Inconclusive")
    const grade = ScoreGate.ciGrade(report)
    expect(grade.exitCode).toBe(5)
    expect(grade.summary).toContain("judge unavailable")
  })
})
