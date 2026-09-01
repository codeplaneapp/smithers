import * as Effect from "effect/Effect"
import { describe, expect, it } from "vitest"
import { EvalError } from "../src/EvalError.ts"
import * as Regression from "../src/Regression.ts"
import * as Report from "../src/Report.ts"
import type * as Runner from "../src/Runner.ts"

const empty = (): Promise<Regression.Report> =>
  Effect.runPromise(
    Regression.compare({ version: 1, records: [] }, { runId: "run", suite: "s", cases: [], observations: [] })
  )

const observation = (
  stepKey: string,
  score: number,
  overrides: Partial<Runner.Observation> = {}
): Runner.Observation => ({
  case: "c",
  scorer: "0123456789abcdef",
  scorerName: "exact",
  stepKey,
  kind: "score",
  score,
  at: "t",
  ...overrides
} as Runner.Observation)

const report = (overrides: Partial<Regression.Report>) =>
  Effect.runPromise(
    Regression.compare(
      { version: 1, records: [{ suite: "s", case: "c", scorer: "0123456789abcdef", stepKey: "old", score: 0.9 }] },
      { runId: "run", suite: "s", cases: [], observations: [observation("new", 0.2)] }
    )
  ).then((base) => ({ ...base, ...overrides }))

describe("Report", () => {
  it("renders stable JSON and a summary-only Markdown report", async () => {
    const result = await empty()
    expect(Report.json(result)).toContain("\"suite\":\"s\"")
    expect(Report.renderJson).toBe(Report.json)
    expect(Report.renderMarkdown).toBe(Report.markdown)
    expect(Report.markdown(result)).toBe(
      [
        "# Evaluation report: s",
        "",
        "- Regressions: 0",
        "- Nondeterminism: 0",
        "- Missing observations: 0",
        "- Inconclusive observations: 0",
        "- Failed cases: 0",
        ""
      ].join("\n").trim() + "\n"
    )
  })

  it("freezes the JSON wire format", async () => {
    const result = await empty()
    expect(Report.json(result)).toBe(
      "{\"baseline\":{\"records\":[],\"version\":1},\"inconclusive\":[],\"missing\":[],\"nondeterminism\":[]," +
        "\"regressions\":[],\"run\":{\"cases\":[],\"observations\":[],\"runId\":\"run\",\"suite\":\"s\"}," +
        "\"samples\":[],\"suite\":\"s\"}\n"
    )
  })

  it("renders a report of a run whose target crashed rather than a page of zeroes", async () => {
    const crashed = await report({
      run: {
        runId: "run",
        suite: "s",
        cases: [
          { case: "healthy", observations: [] },
          {
            case: "crashed",
            error: new EvalError({ code: "executor", message: "Target failed for case 'crashed': boom" }),
            observations: []
          }
        ],
        observations: []
      }
    })
    const rendered = Report.markdown(crashed)
    expect(rendered).toContain("- Failed cases: 1")
    expect(rendered).toContain("## Case failures")
    expect(rendered).toContain("| crashed | executor | Target failed for case 'crashed': boom |")
  })

  it("names every regression, nondeterminism, missing, and inconclusive row", async () => {
    const full = await report({
      regressions: [{
        case: "c",
        scorer: "0123456789abcdef",
        baseline: { suite: "s", case: "c", scorer: "0123456789abcdef", stepKey: "old", score: 0.9 },
        actual: observation("new", 0.2) as Extract<Runner.Observation, { kind: "score" }>,
        drop: 0.7
      }],
      nondeterminism: [{
        case: "c",
        scorer: "0123456789abcdef",
        baseline: { suite: "s", case: "c", scorer: "0123456789abcdef", stepKey: "old", score: 0.9 },
        actual: observation("old", 0.5) as Extract<Runner.Observation, { kind: "score" }>,
        delta: -0.4
      }],
      missing: [{ side: "run", case: "gone", scorer: "0123456789abcdef", stepKey: "old" }],
      inconclusive: [
        {
          case: "c",
          scorer: "0123456789abcdef",
          scorerName: "exact",
          stepKey: "step",
          kind: "inconclusive",
          reason: "judge down",
          at: "t"
        }
      ]
    })
    expect(Report.markdown(full)).toBe(
      [
        "# Evaluation report: s",
        "",
        "- Regressions: 1",
        "- Nondeterminism: 1",
        "- Missing observations: 1",
        "- Inconclusive observations: 1",
        "- Failed cases: 0",
        "",
        "## Regressions",
        "",
        "| Case | Scorer | Baseline | Actual | Drop |",
        "| --- | --- | ---: | ---: | ---: |",
        "| c | exact (01234567) | 0.900000 | 0.200000 | 0.700000 |",
        "",
        "## Nondeterminism",
        "",
        "| Case | Scorer | Step key | Baseline | Actual | Delta |",
        "| --- | --- | --- | ---: | ---: | ---: |",
        "| c | exact (01234567) | old | 0.900000 | 0.500000 | -0.400000 |",
        "",
        "## Missing observations",
        "",
        "| Side | Case | Scorer | Step key |",
        "| --- | --- | --- | --- |",
        "| run | gone | 0123456789abcdef | old |",
        "",
        "## Inconclusive",
        "",
        "| Case | Scorer | Step key | Reason |",
        "| --- | --- | --- | --- |",
        "| c | exact (01234567) | step | judge down |"
      ].join("\n") + "\n"
    )
  })

  it("escapes, flattens, and caps every cell, including the heading", async () => {
    const hostile = await report({
      suite: "s <script>|\nnext",
      missing: [{
        side: "run",
        case: "a|b",
        scorer: "x".repeat(300),
        stepKey: "line\u0000break"
      }]
    })
    const rendered = Report.markdown(hostile)
    expect(rendered.startsWith("# Evaluation report: s <script>\\| next\n")).toBe(true)
    expect(rendered).toContain("| run | a\\|b |")
    expect(rendered).toContain(`${"x".repeat(240)}…`)
    expect(rendered).toContain("line break")
  })

  it("falls back to the scorer key when the scorer has no name", async () => {
    const anonymous = await report({
      inconclusive: [
        {
          case: "c",
          scorer: "0123456789abcdef",
          stepKey: "step",
          kind: "inconclusive",
          reason: "judge down",
          at: "t"
        }
      ]
    })
    expect(Report.markdown(anonymous)).toContain("| c | 0123456789abcdef | step | judge down |")
  })
})
