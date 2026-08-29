import { describe, it } from "@effect/vitest"
import * as Core from "@smthrs/core"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Schema from "effect/Schema"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner"
import { expect } from "vitest"
import * as Plan from "../src/Plan.ts"
import { expectPlan, expectPure } from "../src/PlanAssertions.ts"
import * as TestLayers from "../src/TestLayers.ts"

const review = Core.Flow.make({
  name: "review",
  input: Schema.Struct({
    pr: Schema.Number,
    reviewer: Schema.String.pipe(Schema.withDecodingDefaultKey(Effect.succeed("recorded:reviewer")))
  }),
  output: Schema.String,
  body: (input) =>
    Core.Node.dynamic({
      model: input.reviewer,
      effects: Core.Effects.make({
        reads: [`workspace/pr-${input.pr}.json`],
        writes: ["workspace/review.json"],
        mode: "hermetic",
        onConflict: "serialize",
        tier: "sealed"
      })
    }) as Core.Node.Node<string>
})

describe("plan purity", () => {
  it.effect("computes a plan under poisoned layers without touching Host or Model", () =>
    Effect.gen(function*() {
      // planOf decodes input first: the un-defaulted `reviewer` field cannot
      // reach the plan, so its key already hashes the defaulted value.
      const plan = yield* expectPure(Plan.planOf(review, { pr: 4821 }))
      const defaulted = yield* expectPure(Plan.planOf(review, { pr: 4821, reviewer: "recorded:reviewer" }))
      expect(Plan.render(plan)).toBe(Plan.render(defaulted))
      yield* expectPlan(plan).contains("root")
      yield* expectPlan(plan).node("root").tier("sealed")
      const root = Plan.node(plan, "root")
      expect(root?.key).toMatch(/^key1_[0-9a-f]{64}$/)
      expect(root?.sealed).toBe(true)
    }).pipe(Effect.provide(TestLayers.poisoned)))

  it.effect("rejects un-decodable input before any plan exists", () =>
    Effect.gen(function*() {
      const result = yield* Plan.planOf(review, { pr: "not-a-number" }).pipe(Effect.flip)
      expect(result._tag).toBe("SchemaError")
    }).pipe(Effect.provide(TestLayers.poisoned)))

  it.effect("fails typed when a plan computation reaches a capability", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      // A hypothetical impure planner that consults the filesystem: under the
      // poisoned bundle the capability fails typed, and expectPure surfaces
      // it as a purity violation instead of a plan.
      const impure = fs.readFileString("/workspace/pr.json").pipe(
        Effect.map(() => Plan.fromGraph(Core.Graph.build(Core.Node.succeed("ok"))))
      )
      const direct = yield* impure.pipe(Effect.flip)
      expect(direct._tag).toBe("CapabilityContractError")
      const violation = yield* expectPure(impure).pipe(Effect.flip)
      expect(violation._tag).toBe("PlanAssertionError")
      expect(violation.code).toBe("purity_violation")
    }).pipe(Effect.provide(TestLayers.poisoned)))

  it.effect("keeps the poisoned bundle typed for host services", () =>
    Effect.gen(function*() {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const error = yield* Effect.scoped(spawner.spawn(ChildProcess.make("ls", { shell: true }))).pipe(Effect.flip)
      expect((error as unknown as { readonly _tag: string })._tag).toBe("CapabilityContractError")
    }).pipe(Effect.provide(TestLayers.poisoned)))
})
