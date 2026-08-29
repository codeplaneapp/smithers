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

describe("ScoreGate", () => {
  it("passes mean, minimum, and per-case gates", async () => {
    await expect(Effect.runPromise(ScoreGate.expectScores(samples).mean(0.8))).resolves.toEqual({ _tag: "Passed" })
    await expect(Effect.runPromise(ScoreGate.expectScores(samples).min(0.8))).resolves.toEqual({ _tag: "Passed" })
    await expect(Effect.runPromise(ScoreGate.expectScores(samples).perCase({ first: 0.9, second: 0.8 }))).resolves
      .toEqual({
        _tag: "Passed"
      })
  })

  it("reports a mean threshold miss", async () => {
    await expectFailure(ScoreGate.expectScores(samples).mean(0.86), "mean_below_threshold", 0.86, 0.85)
  })

  it("reports a minimum threshold miss", async () => {
    await expectFailure(ScoreGate.expectScores(samples).min(0.85), "min_below_threshold", 0.85, 0.8)
  })

  it("reports a per-case threshold miss", async () => {
    await expectFailure(ScoreGate.expectScores(samples).perCase({ second: 0.85 }), "case_below_threshold", 0.85, 0.8)
  })

  it("grades inconclusive observations without turning them into score failures", async () => {
    const verdict = await Effect.runPromise(
      ScoreGate.expectScores([
        { case: "first", stepKey: "first-key", scorer: "quality", kind: "inconclusive", reason: "judge unavailable" }
      ]).mean(0.9)
    )
    expect(verdict).toEqual({ _tag: "Inconclusive", reasons: ["judge unavailable", "No score samples for mean gate"] })
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
    expect(report.verdict).toEqual({ _tag: "Passed" })
    expect(report.cases).toHaveLength(2)
    expect(report.samples).toHaveLength(2)
    expect(ScoreGate.ciGrade(report).exitCode).toBe(0)
  })

  it("fails with a typed ScoreGateError on a gate miss", async () => {
    const error = await Effect.runPromise(
      ScoreGate.suite({
        cases,
        run: (suiteCase) => Effect.succeed([sampleFor(suiteCase.name, 0.6)]),
        gates: { mean: 0.8 }
      }).pipe(Effect.flip)
    )
    expect(error).toBeInstanceOf(ScoreGateError)
    expect(error.code).toBe("mean_below_threshold")
  })

  it("grades environment faults inconclusive with CI exit code 5, never failed", async () => {
    const report = await Effect.runPromise(
      ScoreGate.suite({
        cases,
        run: (suiteCase) =>
          suiteCase.name === "first"
            ? Effect.fail(new Error("judge unavailable"))
            : Effect.succeed([sampleFor(suiteCase.name, 0.1)]),
        gates: { mean: 0.99 }
      })
    )
    expect(report.verdict._tag).toBe("Inconclusive")
    const grade = ScoreGate.ciGrade(report)
    expect(grade.exitCode).toBe(5)
    expect(grade.summary).toContain("judge unavailable")
  })
})
