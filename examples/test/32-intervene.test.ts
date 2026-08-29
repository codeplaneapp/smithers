import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import { expect, it } from "@effect/vitest"
import { Graph } from "@smthrs/core"
import * as Effect from "effect/Effect"
import { dryPlan, intervene, main, plan } from "../src/32-intervene.ts"

const literal = (node: Graph.GraphNode): Record<string, unknown> => {
  const first = node.keyMaterial.inputs[0]
  return first !== undefined && first._tag === "Literal" ? first.value as Record<string, unknown> : {}
}

/** The nodes that call the approval, which `WithApproval` marks with a run scope. */
const approvals = (graph: Graph.Graph): ReadonlyArray<Graph.GraphNode> =>
  Graph.nodes(graph).filter((node) => node.kind === "FlowCall" && literal(node).scope === "run")

/** The nodes that call the write. */
const writes = (graph: Graph.Graph): ReadonlyArray<Graph.GraphNode> =>
  Graph.nodes(graph).filter((node) => node.kind === "FlowCall" && literal(node).phase === "apply")

it.effect("rewrites the file once the approval answers approved", () =>
  Effect.gen(function*() {
    const { content, report } = yield* main

    expect(report).toEqual({ path: expect.stringContaining("greeting.txt"), replacements: 1, dryRun: false })
    expect(content).toBe("Hello, Ada.\n")
  }))

it.effect("leaves the file alone on a dry run", () =>
  Effect.gen(function*() {
    const { content, report } = yield* intervene({ dryRun: true, decision: "approved" }).pipe(
      Effect.provide(NodeFileSystem.layer)
    )

    expect(report.dryRun).toBe(true)
    expect(report.replacements).toBe(0)
    expect(content).toBe("Hello, world.\n")
  }))

it.effect("refuses the write when the approval answers anything else", () =>
  Effect.gen(function*() {
    const failure = yield* intervene({ dryRun: false, decision: "denied" }).pipe(
      Effect.provide(NodeFileSystem.layer),
      Effect.flip
    )

    expect(failure._tag).toBe("SchemaError")
  }))

it("plans the approval ahead of the write", () => {
  const graph = Graph.build(plan, "greeting")
  const approval = approvals(graph)

  expect(approval).toHaveLength(1)
  expect(Graph.diagnostics(graph)).toEqual([])
  const gates = Graph.edges(graph).filter((edge) => edge.from === approval[0]!.id)
  expect(gates).toHaveLength(1)
  expect(writes(graph).map((node) => node.id)).toContain(gates[0]!.to)
})

it("plans no write and no approval at all on a dry run", () => {
  const graph = Graph.build(dryPlan, "greeting")

  expect(approvals(graph)).toEqual([])
  expect(writes(graph)).toEqual([])
  expect(
    Graph.nodes(graph).filter((node) => node.kind === "FlowCall" && literal(node).phase === "report")
  ).toHaveLength(1)
  expect(Graph.diagnostics(graph)).toEqual([])
})
