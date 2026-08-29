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
  it("delegates threshold arithmetic and keeps inconclusive green", async () => {
    const failed = await Effect.runPromiseExit(
      Gate.check(report([{ case: "c", scorer: "s", stepKey: "k", kind: "score", score: 0.2, at: "t" }]), {
        min: 0.5
      })
    )
    expect(failed._tag).toBe("Failure")
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
    expect(targetFailed).toMatchObject({ _tag: "Inconclusive", reasons: [expect.stringContaining("target crashed")] })
    expect(missing).toMatchObject({ _tag: "Inconclusive", reasons: [expect.stringContaining("missing run")] })
  })
})
