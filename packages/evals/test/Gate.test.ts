import * as Effect from "effect/Effect"
import { describe, expect, it } from "vitest"
import { EvalError } from "../src/EvalError.ts"
import * as Gate from "../src/Gate.ts"

const report = (
  observations: ReadonlyArray<
    {
      readonly case: string
      readonly scorer: string
      readonly stepKey: string
      readonly kind: "score"
      readonly score: number
      readonly at: string
    }
  >
) => ({
  suite: "s",
  baseline: { version: 1 as const, records: [] },
  run: { runId: "run", suite: "s", cases: [], observations },
  regressions: [],
  nondeterminism: [],
  missing: [],
  samples: observations,
  inconclusive: []
})

describe("Gate", () => {
  it("delegates threshold arithmetic and leaves an unobservable run undecided", async () => {
    const failed = await Effect.runPromise(
      Gate.check(report([{ case: "c", scorer: "s", stepKey: "k", kind: "score", score: 0.2, at: "t" }]), {
        min: 0.5
      })
    )
    expect(failed).toMatchObject({ _tag: "Failed", reasons: ["min_below_threshold: threshold 0.5, actual 0.2"] })
    const inconclusive = await Effect.runPromise(
      Gate.check({
        ...report([]),
        run: {
          runId: "run",
          suite: "s",
          cases: [],
          observations: [{
            case: "c",
            scorer: "s",
            stepKey: "k",
            kind: "inconclusive" as const,
            reason: "unavailable",
            at: "t"
          }]
        }
      }, { min: 0.5 })
    )
    expect(inconclusive._tag).toBe("Inconclusive")
  })

  it("preserves inconclusive without configured thresholds", async () => {
    const verdict = await Effect.runPromise(
      Gate.check({
        ...report([]),
        run: {
          runId: "run",
          suite: "s",
          cases: [],
          observations: [{
            case: "c",
            scorer: "s",
            stepKey: "k",
            kind: "inconclusive" as const,
            reason: "unavailable",
            at: "t"
          }]
        }
      })
    )
    expect(Gate.ciGrade(verdict).exitCode).toBe(5)
  })

  // A regression is a measurement: the run scored lower than the baseline it
  // is gated on. Folding it in with the environment faults reported exit 5,
  // which the CI convention treats as a harness to repair rather than a red.
  it("fails a run that regressed against its baseline", async () => {
    const observation = {
      case: "c",
      scorer: "s",
      stepKey: "changed",
      kind: "score" as const,
      score: 0,
      at: "t"
    }
    const verdict = await Effect.runPromise(
      Gate.check({
        ...report([observation]),
        regressions: [{
          case: "c",
          scorer: "s",
          baseline: { suite: "s", case: "c", scorer: "s", stepKey: "baseline", score: 1 },
          actual: observation,
          drop: 1
        }]
      }, { mean: 0 })
    )
    expect(verdict).toMatchObject({ _tag: "Failed", reasons: [expect.stringContaining("regression for c/s")] })
    expect(Gate.ciGrade(verdict).exitCode).toBe(1)
  })

  it("runs the threshold gates when an observation is missing, and reports both", async () => {
    const verdict = await Effect.runPromise(
      Gate.check({
        ...report([{ case: "c", scorer: "s", stepKey: "k", kind: "score", score: 0.1, at: "t" }]),
        missing: [{ side: "run" as const, case: "other", scorer: "s", stepKey: "k" }]
      }, { mean: 0.9 })
    )
    expect(verdict).toMatchObject({
      _tag: "Failed",
      reasons: [expect.stringContaining("mean_below_threshold")],
      inconclusive: [expect.stringContaining("missing run")]
    })
    expect(Gate.ciGrade(verdict).exitCode).toBe(1)
  })

  it("fails closed on target errors and incomplete regression evidence", async () => {
    const targetFailed = await Effect.runPromise(
      Gate.check({
        ...report([]),
        run: {
          runId: "run",
          suite: "s",
          cases: [{
            case: "crashed",
            error: new EvalError({ code: "executor", message: "target crashed" }),
            observations: []
          }],
          observations: []
        }
      })
    )
    const missing = await Effect.runPromise(
      Gate.check({
        ...report([]),
        missing: [{ side: "run" as const, case: "c", scorer: "s", stepKey: "k" }]
      })
    )
    expect(targetFailed).toMatchObject({
      _tag: "Inconclusive",
      reasons: expect.arrayContaining([expect.stringContaining("target crashed")])
    })
    expect(missing).toMatchObject({
      _tag: "Inconclusive",
      reasons: expect.arrayContaining([expect.stringContaining("missing run")])
    })
  })
})
