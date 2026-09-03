/**
 * The core graph is compiled by the persisted plan package before it reaches
 * the control card. The card carries that exact value plus cache verdicts.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as Core from "@smthrs/core"
import * as PersistedPlan from "@smthrs/plan/Plan"
import { Effect, Result } from "effect"
import { describe, expect, it } from "vitest"
import { Control } from "../src/Control.ts"
import { InvalidInput } from "../src/ControlError.ts"
import type { MemoryFlow } from "../src/ControlRuntime.ts"
import type { PlanNodeStatus } from "../src/ControlSchema.ts"
import * as TestControl from "../src/test/TestControl.ts"

const declaration = (writes: ReadonlyArray<string> = []) =>
  Core.Effects.make({
    reads: [],
    writes,
    mode: "hermetic",
    onConflict: "serialize",
    tier: "sealed"
  })

const graph = (reviewWrites: ReadonlyArray<string> = ["review.json"]): Core.Graph.Graph =>
  Core.Graph.build(Core.Node.all({
    read: Core.Node.dynamic({ model: "recorded:reader", effects: declaration() }),
    review: Core.Node.dynamic({ model: "recorded:reviewer", effects: declaration(reviewWrites) })
  }))

const compile = (
  value: Core.Graph.Graph,
  planId: string
) => {
  const nodes = new Map(Core.Graph.nodes(value).map((node) => [node.id, node]))
  const material = Result.getOrThrow(Core.Graph.keyMaterial(value))
  return PersistedPlan.compile({
    planId,
    flow: "review/pull-request",
    nodes: material.map((entry): PersistedPlan.NodeDraft => {
      const effects = nodes.get(entry.nodeId)?.declaredEffects ?? nodes.get(entry.nodeId)?.effectiveEffects
      return {
        id: entry.nodeId,
        material: entry.material,
        effects: {
          reads: effects?.reads ?? [],
          writes: effects?.writes ?? [],
          boundaryMode: effects?.mode === "expected" ? "expected" : "hard"
        },
        kind: entry.material.body !== null && typeof entry.material.body === "object" &&
            (entry.material.body as { readonly _tag?: unknown })._tag === "Dynamic"
          ? "agent"
          : "step"
      }
    })
  }).pipe(
    Effect.mapError((cause) => new InvalidInput({ issue: String(cause) })),
    Effect.provide(NodeCrypto.layer)
  )
}

const flow = (
  value: Core.Graph.Graph,
  statuses: Readonly<Record<string, PlanNodeStatus>> = {}
): MemoryFlow => ({
  flowId: "review/pull-request",
  description: "Review a pull request.",
  deployClass: false,
  envelope: { capabilities: [], flows: [], budget: {} },
  plan: (_input, planId) => compile(value, planId).pipe(Effect.map((plan) => ({ plan, statuses })))
})

const planned = (
  value: Core.Graph.Graph,
  statuses?: Readonly<Record<string, PlanNodeStatus>>
) =>
  Effect.gen(function*() {
    const control = yield* Control
    return yield* control.plan({ flowId: "review/pull-request", input: { pr: 4821 } })
  }).pipe(
    Effect.provide(TestControl.layer({ flows: [flow(value, statuses)] })),
    Effect.scoped,
    Effect.runPromise
  )

describe("the persisted plan handoff", () => {
  it("carries the exact compiled plan and reports each node's cache outcome", async () => {
    const card = await planned(graph(), {
      "root.all.read": "cached",
      "root.all.review": "run"
    })

    expect(card.plan).toBeDefined()
    expect(card.plan?.planId).toBe(card.planId)
    expect(card.nodes.map((node) => node.key)).toEqual(card.plan?.nodes.map((node) => node.key))
    expect(card.nodes.find((node) => node.id === "root.all.read")?.status).toBe("cached")
    expect(card.nodes.find((node) => node.id === "root.all.review")?.status).toBe("run")
  })

  it("binds approval to the persisted plan digest", async () => {
    const original = await planned(graph(["review.json"]))
    const changed = await planned(graph(["review.json", "audit.json"]))

    expect(changed.plan?.digest).not.toBe(original.plan?.digest)
    expect(changed.digest).not.toBe(original.digest)
    expect(changed.approval.target.digest).toBe(changed.digest)
  })

  it("keeps graph structure that does not enter a step key on the approval surface", async () => {
    const card = await planned(graph())
    const review = card.nodes.find((node) => node.id === "root.all.review")

    expect(review).toMatchObject({
      effects: { writes: ["review.json"] },
      strategy: "serialize",
      runtime: "delay-rebase",
      generation: 0
    })
    expect(review).toHaveProperty("dependsOn")
    expect(review).toHaveProperty("conflicts")
  })

  it("represents hosts without a graph without fabricating a persisted plan", async () => {
    const noGraph: MemoryFlow = {
      flowId: "review/pull-request",
      description: "Review a pull request.",
      deployClass: false,
      envelope: { capabilities: [], flows: [], budget: {} }
    }
    const card = await Effect.gen(function*() {
      const control = yield* Control
      return yield* control.plan({ flowId: noGraph.flowId, input: { pr: 4821 } })
    }).pipe(
      Effect.provide(TestControl.layer({ flows: [noGraph] })),
      Effect.scoped,
      Effect.runPromise
    )

    expect(card.plan).toBeUndefined()
    expect(card.nodes).toEqual([])
    expect(card.digest).toMatch(/^[0-9a-f]{64}$/)
  })
})
