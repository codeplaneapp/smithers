/**
 * The total canonical rendering behind plan snapshots.
 *
 * Key material and diagnostic envelopes can carry values JSON does not name.
 * These cases pin the explicit tags, cycle handling, and small formatting
 * helpers so snapshots stay deterministic instead of throwing or collapsing
 * distinct inputs.
 */
import * as Core from "@smthrs/core"
import * as Effect from "effect/Effect"
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import * as Plan from "../src/Plan.ts"
import { expectPlan } from "../src/PlanAssertions.ts"
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

  it("keeps inherited effects in the envelope of an undeclared node", () => {
    const envelope = Core.Effects.make({
      reads: ["workspace/input"],
      writes: ["workspace/output"],
      mode: "hermetic",
      onConflict: "serialize",
      tier: "compensable"
    })
    const graph = Core.Graph.build(Core.Flow.make({
      effects: envelope,
      body: () => Core.Node.dynamic({})
    }))
    expect(Core.Graph.nodes(graph)[0]!.declaredEffects).toBeUndefined()
    expect(Core.Graph.nodes(graph)[0]!.effectiveEffects).toEqual(envelope)
    const projected = Plan.fromGraph(graph, { key: () => "synthetic-key" })
    const node = projected.nodes[0]!
    expect(node.effects).toEqual([])
    expect(node.envelope).toEqual(envelope)
    expect(node).not.toHaveProperty("mode")
    expect(node).not.toHaveProperty("tier")
    expect(node).not.toHaveProperty("onConflict")
    Effect.runSync(Effect.gen(function*() {
      const assertions = expectPlan(projected).node(node.id)
      yield* assertions.mode(undefined)
      yield* assertions.tier(undefined)
      yield* assertions.onConflict(undefined)
      yield* assertions.declaresEffects([])
      yield* assertions.envelope({ ...envelope })
    }))
  })

  it("accepts the guide's effect assertion for declared paths", () => {
    const graph = Core.Graph.build(Core.Node.withEffects(
      Core.Node.dynamic({}),
      Core.Effects.make({
        reads: ["workspace/input"],
        writes: ["workspace/output"],
        mode: "hermetic",
        onConflict: "serialize"
      })
    ))
    const projected = Plan.fromGraph(graph, { key: () => "synthetic-key" })
    const guide = readFileSync(new URL("../docs/guides/assert-a-plan.md", import.meta.url), "utf8")
    const sample = guide.match(/planned\.declaresEffects\("test", (\[[^\]]*\])/)
    expect(sample).not.toBeNull()
    const effects = JSON.parse(sample![1]!) as Array<string>
    Effect.runSync(expectPlan(projected).node(projected.nodes[0]!.id).declaresEffects(effects))
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
