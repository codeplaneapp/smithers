import { describe, it } from "@effect/vitest"
import * as Core from "@smthrs/core"
import * as Digest from "@smthrs/core/Digest"
import * as CoreGraph from "@smthrs/core/Graph"
import * as StepKey from "@smthrs/plan/StepKey"
import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import { expect } from "vitest"
import * as Plan from "../src/Plan.ts"

// `Plan.keys` derives two different identities, and the reference documents
// both. Sealed material is keyed the way the persisted plan keys it. Every
// other tier is keyed as the run-local ordinal the engine dispatches under,
// which `Plan.compile`'s `StepKey.planIdentity` fingerprint deliberately does
// not reproduce: that one keys a non-sealed tier in the `plan-declaration`
// namespace, independently of any run.

const graphOf = (tier: "sealed" | "compensable"): CoreGraph.Graph =>
  CoreGraph.build(
    Core.Node.withEffects(
      Core.Node.dynamic({ model: "recorded:reviewer" }),
      Core.Effects.make({
        reads: ["workspace/pr.json"],
        writes: ["workspace/review.json"],
        mode: "hermetic",
        onConflict: "serialize",
        tier
      })
    )
  )

/** The declaration of the given tier, with the ordinal position `keys` gives it. */
const declarationOf = (graph: CoreGraph.Graph, kind: string) => {
  const entries = Result.getOrThrow(CoreGraph.keyMaterial(graph))
  const ordinal = entries.findIndex((entry) => entry.material.kind === kind)
  expect(ordinal).toBeGreaterThanOrEqual(0)
  return { entry: entries[ordinal]!, ordinal }
}

const runKey = <A, E>(effect: Effect.Effect<A, E, import("effect/Crypto").Crypto>): A =>
  Effect.runSync(Digest.provideSync(effect))

describe("plan key identity", () => {
  it("keys sealed material the way the persisted plan keys it", () => {
    const graph = graphOf("sealed")
    const { entry } = declarationOf(graph, "sealed")
    expect(Plan.keys(graph)[entry.nodeId]).toBe(runKey(StepKey.planIdentity(entry.material, {})))
  })

  it("keys non-sealed material as a run-local ordinal, not a plan fingerprint", () => {
    const graph = graphOf("compensable")
    const { entry, ordinal } = declarationOf(graph, "compensable")
    const key = Plan.keys(graph, { runId: "identity-test" })[entry.nodeId]
    expect(key).toBe(runKey(StepKey.ordinal({
      runId: "identity-test",
      parentScope: entry.nodeId,
      ordinal,
      tier: "compensable"
    })))
    expect(key).not.toBe(runKey(StepKey.planIdentity(entry.material, {})))
  })
})
