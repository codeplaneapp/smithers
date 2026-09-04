import { describe, expect, test } from "bun:test"
import forceGraph from "../../../../packages/rpc/fixtures/force/graph.json"
import forcePlan from "../../../../packages/rpc/fixtures/force/plan-typeCheck.json"
import { foldPlan, loaderFailureText, parseTextGraph } from "./TargetGraph"

describe("loaderFailureText", () => {
  test("a JSON failure envelope on stdout leads, even with an empty stderr", () => {
    // `smithers-build graph //... --format json` on a broken checkout: exit 1, nothing on stderr.
    const stdout = JSON.stringify({ code: "graph_failed", message: "declared input is not a regular file: packages/smithers/flows/jj/wasm" })
    expect(loaderFailureText(stdout, "")).toBe("graph_failed: declared input is not a regular file: packages/smithers/flows/jj/wasm")
  })
  test("stderr follows the envelope, stands alone without one, and a silent exit says so", () => {
    expect(loaderFailureText(JSON.stringify({ message: "boom" }), "  trace\n")).toBe("boom\ntrace")
    expect(loaderFailureText("not json", "ENOENT")).toBe("ENOENT")
    expect(loaderFailureText("", "")).toBe("no output")
  })
})

describe("parseTextGraph", () => {
  test("parses the force fixture exactly", () => {
    const parsed = parseTextGraph(forceGraph.graph, forceGraph.targets)
    expect(parsed.nodes).toHaveLength(82)
    expect(parsed.edges).toHaveLength(94)
    expect(new Set(parsed.edges.map((edge) => edge.kind))).toEqual(new Set(["data", "gates", "services"]))
    expect(parsed.nodes.find((node) => node.label === "//src:typeCheck")).toMatchObject({ rule: "Shell.Test", package: "//src", name: "typeCheck" })
  })

  test("parses a scoped `graph <label>` tree: depth by glyph column, rule from the parens, [seen] repeats folded", () => {
    /* Verbatim from `smithers-build graph //packages/smithers/flows/engine:check --format json` on this checkout. */
    const tree = [
      "//packages/smithers/flows/engine:check (Typecheck)",
      "├─ //packages/smithers/flows/engine:lib (TsBuild)",
      "│  └─ //packages/smithers/flows/flow:lib (TsBuild)",
      "│     └─ //packages/smithers/flows/plan:lib (TsBuild)",
      "└─ //packages/smithers/flows/flow:lib (TsBuild) [seen]"
    ].join("\n")
    const parsed = parseTextGraph(tree)
    expect(parsed.nodes.map((node) => node.label).sort()).toEqual([
      "//packages/smithers/flows/engine:check",
      "//packages/smithers/flows/engine:lib",
      "//packages/smithers/flows/flow:lib",
      "//packages/smithers/flows/plan:lib"
    ])
    expect(parsed.edges).toEqual([
      { from: "//packages/smithers/flows/engine:check", to: "//packages/smithers/flows/engine:lib", kind: "deps" },
      { from: "//packages/smithers/flows/engine:lib", to: "//packages/smithers/flows/flow:lib", kind: "deps" },
      { from: "//packages/smithers/flows/flow:lib", to: "//packages/smithers/flows/plan:lib", kind: "deps" },
      { from: "//packages/smithers/flows/engine:check", to: "//packages/smithers/flows/flow:lib", kind: "deps" }
    ])
    expect(parsed.nodes.find((node) => node.label === "//packages/smithers/flows/engine:check")?.rule).toBe("Typecheck")
    expect(parsed.nodes.find((node) => node.label === "//packages/smithers/flows/plan:lib")?.rule).toBe("TsBuild")
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
