/** The main plan value grows when the harness elaborates a child batch. */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as HarnessPlan from "@smthrs/harness/Plan"
import * as PersistedPlan from "@smthrs/plan/Plan"
import * as StepKey from "@smthrs/plan/StepKey"
import { Effect, Option } from "effect"
import { describe, expect, it } from "vitest"
import * as FlowEngineLike from "../src/FlowEngineLike.ts"

const scope = { layers: ["layer-a", "layer-b"], run: "review/exec-1" }

const child = (
  callId: string,
  args: unknown = { path: "notes/todo.md" }
): HarnessPlan.Child =>
  new HarnessPlan.Child({
    flowName: "fs/write",
    callId,
    args,
    capabilities: ["fs:write"],
    effects: {
      reads: [],
      writes: ["notes/todo.md"],
      mode: "hermetic",
      onConflict: "serialize",
      tier: "sealed"
    },
    placement: Option.none()
  })

const material = (id: string) => ({
  version: "flows/key-material/v2" as const,
  kind: "sealed" as const,
  body: { activity: id },
  inputs: [],
  layers: [],
  capabilities: []
})

const basePlan = PersistedPlan.compile({
  planId: "review-plan",
  flow: "review",
  nodes: [{
    id: "root",
    material: material("root"),
    effects: { reads: [], writes: [], boundaryMode: "hard" }
  }]
})

const append = (batch: HarnessPlan.Batch) =>
  Effect.gen(function*() {
    const base = yield* basePlan
    const grown = yield* FlowEngineLike.appendBatch(base, batch, scope)
    return { base, grown }
  }).pipe(Effect.provide(NodeCrypto.layer), Effect.runPromise)

describe("appendBatch", () => {
  it("appends keyed nodes as a new generation without rewriting the base", async () => {
    const { base, grown } = await append(new HarnessPlan.Batch({ children: [child("call_1")] }))

    expect(grown.generation).toBe(1)
    expect(grown.nodes[0]).toEqual(base.nodes[0])
    expect(grown.nodes[1]).toMatchObject({ id: "call_1", generation: 1 })
    expect(grown.nodes[1]!.key).toMatch(/^key1_[0-9a-f]{64}$/)
    expect(grown.digest).not.toBe(base.digest)
  })

  it("uses the same material compiler as direct step dispatch", async () => {
    const { grown } = await append(new HarnessPlan.Batch({ children: [child("call_1")] }))
    const appended = grown.nodes[1]!
    const expected = await StepKey.fromKeyMaterial(appended.material, {}).pipe(
      Effect.provide(NodeCrypto.layer),
      Effect.runPromise
    )

    expect(appended.material.version).toBe("flows/key-material/v2")
    expect(appended.material.body).toMatchObject({ _tag: "FlowChild", flowName: "fs/write" })
    expect(appended.key).toBe(expected)
  })

  it("re-keys a child whose arguments changed", async () => {
    const first = await append(new HarnessPlan.Batch({ children: [child("call_1")] }))
    const changed = await append(
      new HarnessPlan.Batch({ children: [child("call_1", { path: "notes/other.md" })] })
    )

    expect(changed.grown.nodes[1]!.key).not.toBe(first.grown.nodes[1]!.key)
  })

  it("advances the plan generation even for an empty append", async () => {
    const { base, grown } = await append(new HarnessPlan.Batch({ children: [] }))

    expect(grown.nodes).toEqual(base.nodes)
    expect(grown.generation).toBe(1)
  })
})
