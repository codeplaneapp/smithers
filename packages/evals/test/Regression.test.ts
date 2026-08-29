import * as Effect from "effect/Effect"
import { describe, expect, it } from "vitest"
import * as Baseline from "../src/Baseline.ts"
import * as Regression from "../src/Regression.ts"

const baseline = {
  version: 1 as const,
  records: [{ suite: "s", case: "c", scorer: "x", stepKey: "old", score: 0.9 }]
}
const run = (stepKey: string, score: number) => ({
  runId: "run",
  suite: "s",
  cases: [],
  observations: [{ case: "c", scorer: "x", stepKey, kind: "score" as const, score, at: "t" }]
})

describe("Regression", () => {
  it("distinguishes a changed key regression from same-key nondeterminism", async () => {
    const changed = await Effect.runPromise(Regression.compare(baseline, run("new", 0.2)))
    const same = await Effect.runPromise(Regression.compare(baseline, run("old", 0.2)))
    expect(changed.regressions).toHaveLength(1)
    expect(changed.nondeterminism).toHaveLength(0)
    expect(same.regressions).toHaveLength(0)
    expect(same.nondeterminism).toHaveLength(1)
  })

  it("retains missing observations", async () => {
    const result = await Effect.runPromise(
      Regression.compare(baseline, { runId: "run", suite: "s", cases: [], observations: [] })
    )
    expect(result.missing).toEqual([{ side: "run", case: "c", scorer: "x", stepKey: "old" }])
  })

  it("matches repeated scorer observations by step key before array order", async () => {
    const repeated = {
      version: 1 as const,
      records: [
        { suite: "s", case: "c", scorer: "x", stepKey: "a", score: 0.2 },
        { suite: "s", case: "c", scorer: "x", stepKey: "b", score: 0.8 }
      ]
    }
    const result = await Effect.runPromise(
      Regression.compare(repeated, {
        runId: "run",
        suite: "s",
        cases: [],
        observations: [
          { case: "c", scorer: "x", stepKey: "b", kind: "score" as const, score: 0.8, at: "t" },
          { case: "c", scorer: "x", stepKey: "a", kind: "score" as const, score: 0.2, at: "t" }
        ]
      })
    )
    expect(result.regressions).toEqual([])
    expect(result.nondeterminism).toEqual([])
    expect(result.missing).toEqual([])
  })
})
