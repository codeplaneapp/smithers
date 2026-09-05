import { afterEach, describe, expect, it, vi } from "vitest"
import * as RuntimeGraph from "../src/internal/RuntimeGraph.ts"
import { compile, draft, drive } from "./SchedulerDifferentialHarness.ts"

afterEach(() => vi.restoreAllMocks())

describe("indexed scheduler composed operation counts", () => {
  for (const shape of ["chain", "wide"] as const) {
    it(`${shape}: the actual scheduler uses one graph and touches only affected dependents`, async () => {
      const size = 128
      const plan = await compile(
        Array.from({ length: size }, (_, i) => draft(String(i), shape === "chain" && i > 0 ? [String(i - 1)] : []))
      )
      const graphs: Array<RuntimeGraph.RuntimeGraph> = []
      const deltas: Array<RuntimeGraph.Work> = []
      const make = RuntimeGraph.make
      vi.spyOn(RuntimeGraph, "make").mockImplementation((nodes) => {
        const graph = make(nodes)
        const reconcile = graph.reconcile
        vi.spyOn(graph, "reconcile").mockImplementation(() => {
          const before = { ...graph.cost.settlement }
          reconcile()
          deltas.push({
            nodes: graph.cost.settlement.nodes - before.nodes,
            edges: graph.cost.settlement.edges - before.edges,
            allocations: graph.cost.settlement.allocations - before.allocations,
            membership: graph.cost.settlement.membership - before.membership
          })
        })
        graphs.push(graph)
        return graph
      })
      const observed = await drive({ plan }, false)
      expect(observed.reports[0]!.settlements.every((node) => node.outcome === "built")).toBe(true)
      expect(graphs).toHaveLength(1)
      const graph = graphs[0]!
      const edges = shape === "chain" ? size - 1 : 0
      expect(graph.remaining).toBe(0)
      expect(graph.cost.update.nodes).toBe(2 * size)
      expect(graph.cost.update.edges).toBe(edges)
      expect(graph.cost.settlement).toEqual({ nodes: 2 * size + edges, edges, allocations: 0, membership: size })
      expect(graph.cost.admission.membership).toBe(2 * size)
      expect(graph.cost.frontier.nodes).toBe(size)
      expect(deltas.every((delta) => delta.edges <= 1 && delta.nodes <= 2 && delta.allocations === 0)).toBe(true)
    })
  }
})
