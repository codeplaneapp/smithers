import * as Effect from "effect/Effect"
import { describe, expect, it } from "vitest"
import * as Regression from "../src/Regression.ts"
import * as Report from "../src/Report.ts"

describe("Report", () => {
  it("renders stable JSON and concise Markdown", async () => {
    const result = await Effect.runPromise(
      Regression.compare(
        { version: 1, records: [] },
        { runId: "run", suite: "s", cases: [], observations: [] }
      )
    )
    expect(Report.json(result)).toContain("\"suite\":\"s\"")
    expect(Report.markdown(result)).toContain("# Evaluation report: s")
  })
})
