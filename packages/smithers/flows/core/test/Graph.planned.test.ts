import { describe, expect, it } from "@effect/vitest"
import * as Graph from "../src/Graph.ts"
import * as Node from "../src/Node.ts"

const bodyOf = (graph: Graph.Graph, id: string): unknown =>
  Graph.nodes(graph).find((node) => node.id === id)?.keyMaterial.body

describe("planned placeholder", () => {
  it("records a member read as an input reference", () => {
    const graph = Graph.build(
      Node.andThen(
        Node.succeed({ report: { url: "ignored" } }),
        (value: { readonly report: { readonly url: string } }) => Node.succeed(value.report.url)
      )
    )

    expect(bodyOf(graph, "root.then")).toEqual({
      _tag: "Succeed",
      value: { _tag: "PlannedInput", path: ["report", "url"] }
    })
    expect(Graph.nodes(graph).find((node) => node.id === "root.then")?.keyMaterial.inputs).toContainEqual({
      _tag: "Pending",
      from: "root.andThen"
    })
  })

  // The `Node.andThen` JSDoc documents that computing on the placeholder bakes
  // a coerced literal into the plan. This test pins the documented consequence
  // so the trap cannot change silently; making the placeholder refuse coercion
  // is a breaking change tracked outside this package.
  it("coerces to a placeholder literal when a builder computes on it", () => {
    const graph = Graph.build(Node.andThen(Node.succeed(1), (value: number) => Node.succeed(value + 1)))

    expect(bodyOf(graph, "root.then")).toEqual({ _tag: "Succeed", value: "[planned:]1" })
    expect(Graph.diagnostics(graph)).toEqual([])
  })

  // Likewise: a conditional on the placeholder is always truthy, so only the
  // truthy arm reaches the plan.
  it("plans only the truthy arm when a builder branches on it", () => {
    const graph = Graph.build(
      Node.andThen(Node.succeed(true), (value: boolean) => value ? Node.succeed("yes") : Node.succeed("no"))
    )

    expect(bodyOf(graph, "root.then")).toEqual({ _tag: "Succeed", value: "yes" })
  })
})
