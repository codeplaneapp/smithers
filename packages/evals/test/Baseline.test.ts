import * as Effect from "effect/Effect"
import { describe, expect, it } from "vitest"
import * as Baseline from "../src/Baseline.ts"

describe("Baseline", () => {
  it("builds records only from successful score observations", async () => {
    const baseline = await Effect.runPromise(Baseline.fromRun({
      runId: "run",
      suite: "suite",
      cases: [],
      observations: [
        { case: "scored", scorer: "judge", stepKey: "step-1", kind: "score", score: 0.75, at: "now" },
        {
          case: "skipped",
          scorer: "judge",
          stepKey: "step-2",
          kind: "inconclusive",
          reason: "unavailable",
          at: "now"
        }
      ]
    }))

    expect(baseline.records).toEqual([
      { suite: "suite", case: "scored", scorer: "judge", stepKey: "step-1", score: 0.75 }
    ])
  })

  it("writes sorted canonical JSON and validates its version", async () => {
    const baseline = await Effect.runPromise(
      Baseline.load(
        "{\"version\":1,\"records\":[{\"suite\":\"s\",\"case\":\"c\",\"scorer\":\"x\",\"stepKey\":\"k\",\"score\":0.5}]}"
      )
    )
    expect(Baseline.write(baseline)).toBe(
      "{\"records\":[{\"case\":\"c\",\"score\":0.5,\"scorer\":\"x\",\"stepKey\":\"k\",\"suite\":\"s\"}],\"version\":1}\n"
    )
    const bad = await Effect.runPromiseExit(Baseline.load("{\"version\":2,\"records\":[]}"))
    expect(bad._tag).toBe("Failure")
  })

  it("orders non-ASCII keys by code unit", async () => {
    const baseline = await Effect.runPromise(Baseline.make({
      records: [
        { suite: "é", case: "c", scorer: "x", stepKey: "k", score: 1 },
        { suite: "z", case: "c", scorer: "x", stepKey: "k", score: 1 }
      ]
    }))
    expect(JSON.parse(Baseline.write(baseline)).records.map((record: { suite: string }) => record.suite)).toEqual([
      "z",
      "é"
    ])
  })
})
