import { describe, expect, test } from "bun:test"
import forceGraph from "../../../shared/fixtures/force/graph.json"
import forcePlan from "../../../shared/fixtures/force/plan-typeCheck.json"
import { foldPlan, parseTextGraph } from "./TargetGraph"

describe("parseTextGraph", () => {
  test("parses the force fixture exactly", () => {
    const parsed = parseTextGraph(forceGraph.graph, forceGraph.targets)
    expect(parsed.nodes).toHaveLength(82)
    expect(parsed.edges).toHaveLength(94)
    expect(new Set(parsed.edges.map((edge) => edge.kind))).toEqual(new Set(["data", "gates", "services"]))
    expect(parsed.nodes.find((node) => node.label === "//src:typeCheck")).toMatchObject({ rule: "Shell.Test", package: "//src", name: "typeCheck" })
  })

  test("keeps private dependencies and the plain deps kind", () => {
    const parsed = parseTextGraph("//src:public\n  -deps-> //src:__private_Overlay_4")
    expect(parsed.edges).toEqual([{ from: "//src:public", to: "//src:__private_Overlay_4", kind: "deps" }])
    expect(parsed.nodes.find((node) => node.private)).toMatchObject({ label: "//src:__private_Overlay_4", name: "__private_Overlay_4" })
  })
})

test("foldPlan adds structured plan facts without dropping graph nodes", () => {
  const graph = parseTextGraph(forceGraph.graph, forceGraph.targets)
  const nodes = foldPlan(graph.nodes, [forcePlan])
  expect(nodes).toHaveLength(82)
  expect(nodes.find((node) => node.label === "//src:typeCheck")?.plan).toMatchObject({
    mode: "execute",
    cacheable: true,
    key: "83972035f4fb7ae765630a96173ee529617cc5e3c6a249a6b083297e1306d546",
    argv: ["/Users/williamcory/artsy/force/node_modules/.bin/tsc"]
  })
})
