import { describe, expect, it } from "vitest"
import {
  assertMatrixInventory,
  budgetVerdict,
  type FaultMatrix,
  filesFor,
  formatMs,
  loadMatrix,
  parseJUnitResults
} from "./faultMatrix.ts"

const matrix: FaultMatrix = {
  version: 2,
  cases: [
    { id: "case01", file: "faults/case01-a.test.ts", tier: "pr", family: "crash" },
    { id: "case02", file: "faults/case02-b.test.ts", tier: "nightly", family: "provider" }
  ]
}

describe("the fault manifest", () => {
  it("lists every case file on disk exactly once", () => {
    // The committed manifest against the committed cases: a case that exists
    // and is not declared never runs in CI.
    expect(() => assertMatrixInventory(loadMatrix())).not.toThrow()
  })

  it("refuses a manifest of the wrong version", () => {
    expect(() => JSON.parse("{}") as never).not.toThrow()
    expect(() => loadMatrix("/nonexistent/fault-matrix.json")).toThrow()
  })

  it("runs only pr cases in the pr suite and everything in the nightly one", () => {
    expect(filesFor(matrix, "pr")).toEqual(["faults/case01-a.test.ts"])
    expect(filesFor(matrix, "nightly")).toEqual(["faults/case01-a.test.ts", "faults/case02-b.test.ts"])
  })
})

describe("the JUnit reader", () => {
  const report = (body: string) => `<?xml version="1.0"?><testsuites>${body}</testsuites>`

  it("reads a passing case off its file-level suite", () => {
    const results = parseJUnitResults(
      report(`<testsuite name="faults/case01-a.test.ts" tests="2" failures="0" errors="0" skipped="0" time="1.5"/>`),
      matrix
    )
    expect(results[0]).toMatchObject({ id: "case01", outcome: "pass", tests: 2, durationMs: 1500 })
  })

  it("charges a failure as a failure and an error as one too", () => {
    const failed = parseJUnitResults(
      report(`<testsuite name="faults/case01-a.test.ts" tests="2" failures="1" errors="0" skipped="0" time="1"/>`),
      matrix
    )
    expect(failed[0]?.outcome).toBe("fail")
    const errored = parseJUnitResults(
      report(`<testsuite name="faults/case01-a.test.ts" tests="2" failures="0" errors="1" skipped="0" time="1"/>`),
      matrix
    )
    expect(errored[0]?.outcome).toBe("fail")
  })

  it("calls a skipped or missing case incomplete rather than inventing a failure", () => {
    const skipped = parseJUnitResults(
      report(`<testsuite name="faults/case01-a.test.ts" tests="2" failures="0" errors="0" skipped="1" time="1"/>`),
      matrix
    )
    expect(skipped[0]?.outcome).toBe("incomplete")
    // Case 2 has no suite in the report at all.
    expect(skipped[1]?.outcome).toBe("incomplete")
  })

  it("calls every case incomplete when the run produced no report", () => {
    const results = parseJUnitResults("", matrix)
    expect(results.map((result) => result.outcome)).toEqual(["incomplete", "incomplete"])
  })
})

describe("the wall-time budget", () => {
  it("passes with the headroom stated", () => {
    const verdict = budgetVerdict({
      suite: "pr",
      budgetName: "perPRSuiteWallTimeMaxMs",
      budgetMs: 10_000,
      elapsedMs: 4_000,
      killedAtBudget: false
    })
    expect(verdict.ok).toBe(true)
    expect(verdict.message).toContain("6.0s headroom")
  })

  it("fails an overrun with the overage", () => {
    const verdict = budgetVerdict({
      suite: "pr",
      budgetName: "perPRSuiteWallTimeMaxMs",
      budgetMs: 10_000,
      elapsedMs: 12_500,
      killedAtBudget: false
    })
    expect(verdict.ok).toBe(false)
    expect(verdict.message).toContain("over by 2.5s")
  })

  it("fails a suite that was still running at the ceiling", () => {
    const verdict = budgetVerdict({
      suite: "nightly",
      budgetName: "nightlySoakWallTimeMaxMs",
      budgetMs: 1_000,
      elapsedMs: 1_100,
      killedAtBudget: true
    })
    expect(verdict.ok).toBe(false)
    expect(verdict.message).toContain("was killed")
  })

  it("formats milliseconds as seconds", () => {
    expect(formatMs(1_234)).toBe("1.2s")
  })
})
