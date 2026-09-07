import { describe, expect, test } from "vitest"
import { FACTORY_PROJECTION_PATH, FactoryProjectionSchema, ruleFlows } from "../src/FactoryProjection.ts"

/*
 * The projection contract the Dispatcher card reads signed out and the
 * projection target writes: the declaration's own field names, rows in the
 * event vocabulary, a flow id or a list of them, and an optional sentence.
 */
describe("the factory projection", () => {
  test("lives at .smithers/factory.json", () => {
    expect(FACTORY_PROJECTION_PATH).toBe(".smithers/factory.json")
  })

  test("decodes the day-one table with a flow id or a list per row", () => {
    const projection = FactoryProjectionSchema.parse({
      summary: "How smithersai/smithers develops itself.",
      flows: ["issue", "implement", "review", "wiki", "history.fold", "improve.mine"],
      on: [
        { event: "issue.opened", flow: "issue", description: "Triage every new issue" },
        { event: "change.landed", flow: ["wiki", "history.fold", "improve.mine"] },
        { event: "schedule:0 9 * * 1-5", flow: "review" }
      ]
    })
    expect(projection.on).toHaveLength(3)
    expect(ruleFlows(projection.on[0]!)).toEqual(["issue"])
    expect(ruleFlows(projection.on[1]!)).toEqual(["wiki", "history.fold", "improve.mine"])
  })

  test("a table alone decodes; an empty flow list, an empty event, or a missing table does not", () => {
    expect(FactoryProjectionSchema.safeParse({ on: [] }).success).toBe(true)
    expect(FactoryProjectionSchema.safeParse({ on: [{ event: "manual", flow: [] }] }).success).toBe(false)
    expect(FactoryProjectionSchema.safeParse({ on: [{ event: "", flow: "issue" }] }).success).toBe(false)
    expect(FactoryProjectionSchema.safeParse({ flows: ["issue"] }).success).toBe(false)
  })
})
