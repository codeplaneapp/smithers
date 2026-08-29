import { describe, it } from "@effect/vitest"
import { Flow, Graph, Node } from "@smthrs/core"
import * as Schema from "effect/Schema"
import { expect } from "vitest"
import * as Panel from "../src/Panel.ts"
import { PatternError } from "../src/PatternError.ts"

const participant = Flow.make({
  input: Schema.Unknown,
  output: Schema.Unknown,
  body: (input) => Node.succeed(input)
})

describe("Panel", () => {
  it("declares keyed fail-fast fan-out", () => {
    const panel = Panel.make({
      panelists: { one: participant, two: participant },
      moderator: participant
    })

    expect(Flow.isFlow(panel)).toBe(true)
    expect(panel.body?.("topic").ast._tag).toBe("AndThen")
    const graph = Graph.build(panel, "topic")
    expect(Graph.nodes(graph).filter((node) => node.kind === "FlowCall")).toHaveLength(3)
    expect(Graph.nodes(graph).filter((node) => node.kind === "All")).toHaveLength(1)
    expect(Graph.nodes(graph).find((node) => node.id === "root.then")?.keyMaterial.inputs).toContainEqual({
      _tag: "Ref",
      from: "root.andThen",
      path: []
    })
  })

  it("rejects an empty panel", () => {
    expect(() => Panel.make({ panelists: {}, moderator: participant })).toThrow(PatternError)
  })
})
