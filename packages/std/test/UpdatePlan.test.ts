import { Effect, Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as UpdatePlan from "../src/UpdatePlan.ts"

describe("UpdatePlan", () => {
  it("acknowledges with Codex's exact response text", async () => {
    const result = await Effect.runPromise(UpdatePlan.run({
      explanation: "kick off",
      plan: [
        { step: "read the code", status: "completed" },
        { step: "write the fix", status: "in_progress" },
        { step: "run the tests", status: "pending" }
      ]
    }))
    expect(result).toEqual({ output: "Plan updated" })
  })

  it("rejects unknown statuses at the schema boundary", () => {
    const decoded = Schema.decodeUnknownEffect(UpdatePlan.Input)({
      plan: [{ step: "x", status: "done" }]
    })
    expect(() => Effect.runSync(decoded)).toThrow()
  })
})
