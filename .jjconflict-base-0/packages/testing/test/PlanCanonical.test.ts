/**
 * The total canonical rendering behind plan snapshots.
 *
 * Key material and diagnostic envelopes can carry values JSON does not name.
 * These cases pin the explicit tags, cycle handling, and small formatting
 * helpers so snapshots stay deterministic instead of throwing or collapsing
 * distinct inputs.
 */
import * as Core from "@smthrs/core"
import { describe, expect, it } from "vitest"
import * as Plan from "../src/Plan.ts"
import type { PlanLike } from "../src/PlanLike.ts"

const emptyPlan = (envelope: Record<string, unknown>): PlanLike => ({
  nodes: [],
  edges: [],
  envelope
})

describe("Plan canonical rendering", () => {
  it("tags exotic values and terminates cycles", () => {
    const cycle: Record<string, unknown> = {}
    cycle.self = cycle
    const rendered = Plan.render(emptyPlan({
      bigint: 7n,
      cycle,
      function: () => "not invoked",
      list: [undefined],
      namedSymbol: Symbol("lane"),
      unnamedSymbol: Symbol()
    }))

    expect(rendered).toBe(
      "envelope {\"bigint\":{\"_tag\":\"BigInt\",\"value\":\"7\"},\"cycle\":{\"self\":{\"_tag\":\"Circular\"}},\"function\":{\"_tag\":\"Function\"},\"list\":[null],\"namedSymbol\":{\"_tag\":\"Symbol\",\"value\":\"lane\"},\"unnamedSymbol\":{\"_tag\":\"Symbol\",\"value\":null}}"
    )
  })

  it("renders an edge directly", () => {
    expect(Plan.edge({ from: "prepare", to: "publish" })).toBe("prepare -> publish")
  })

  it("projects a placement without retaining undefined options", () => {
    const graph = Core.Graph.build(
      Core.Node.within(
        Core.Node.succeed("ok"),
        Core.Placement.remote({ profile: "reviewer", target: "control-plane" })
      )
    )
    const projected = Plan.fromGraph(graph, { key: () => "synthetic-key" })
    expect(projected.nodes[0]).toMatchObject({
      key: "synthetic-key",
      placement: {
        tag: "flows/core/Placement/Remote",
        options: { profile: "reviewer", target: "control-plane" }
      }
    })
  })

  it("derives an ordinal key and projects a declared tier", () => {
    const graph = Core.Graph.build(
      Core.Node.withEffects(
        Core.Node.dynamic({}),
        Core.Effects.make({
          reads: [],
          writes: [],
          mode: "hermetic",
          onConflict: "serialize",
          tier: "compensable"
        })
      )
    )
    const projected = Plan.fromGraph(graph, { runId: "canonical-test" })
    expect(projected.nodes[0]).toMatchObject({
      sealed: false,
      tier: "compensable"
    })
    const anotherRun = Plan.fromGraph(graph, { runId: "another-run" })
    expect(projected.nodes[0]!.key).not.toBe(anotherRun.nodes[0]!.key)
  })

  it("omits an undeclared effect tier", () => {
    const graph = Core.Graph.build(
      Core.Node.withEffects(
        Core.Node.dynamic({}),
        Core.Effects.make({
          reads: ["workspace/input"],
          writes: [],
          mode: "expected",
          onConflict: "lane"
        })
      )
    )
    const projected = Plan.fromGraph(graph, { key: () => "synthetic-key" })
    expect(projected.nodes[0]).toMatchObject({ mode: "expected", onConflict: "lane" })
    expect(projected.nodes[0]).not.toHaveProperty("tier")
  })
})
