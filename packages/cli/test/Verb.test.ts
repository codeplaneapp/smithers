import { SystemFlows } from "@smthrs/control"
import { describe, expect, it } from "vitest"
import { verbs } from "../src/Verb.ts"

describe("Verb", () => {
  it("has exactly the accepted command headings", () => {
    expect(verbs.map((verb) => verb.name)).toEqual([
      "plan",
      "run",
      "release",
      "serve",
      "up",
      "ls",
      "ps",
      "logs",
      "status",
      "cancel",
      "approve",
      "deny",
      "signal",
      "replay",
      "add",
      "remove",
      "eject",
      "test",
      "init",
      "doctor",
      "migrate",
      "docs"
    ])
  })

  it("is a direct projection of the system-flow catalog", () => {
    expect(verbs.map((verb) => ({ name: verb.name, flowId: verb.flowId }))).toEqual(
      SystemFlows.catalog.map((entry) => ({ name: entry.verb, flowId: entry.flowId }))
    )
  })

  it("preserves catalog deploy and planning classifications", () => {
    expect(verbs.map((verb) => ({ name: verb.name, deployClass: verb.deployClass, planBearing: verb.planBearing })))
      .toEqual(
        SystemFlows.catalog.map((entry) => ({
          name: entry.verb,
          deployClass: entry.deployClass,
          planBearing: entry.planBearing
        }))
      )
  })
})
