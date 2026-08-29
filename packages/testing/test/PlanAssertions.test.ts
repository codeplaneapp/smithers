import { describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { expect } from "vitest"
import * as Plan from "../src/Plan.ts"
import { expectKeyGoldens, expectPlan, expectPlans, expectPure } from "../src/PlanAssertions.ts"
import type { PlanLike } from "../src/PlanLike.ts"

// Structural unit fixture; the applied suite covers Plan.fromGraph over /core.
const plan: PlanLike = {
  digest: "plan:review:small-pr",
  envelope: {
    deny: ["proc:spawn"],
    may: ["fs:read ./", "net:get api.github.com"]
  },
  nodes: [
    {
      id: "read-pr",
      key: "key:read-pr",
      kind: "step",
      placement: { tag: "local", options: {} },
      effects: ["fs:read", "net:get"],
      mode: "hermetic",
      tier: "sealed",
      onConflict: "serialize",
      sealed: true
    },
    {
      id: "lint",
      key: "key:lint",
      kind: "step",
      placement: { tag: "sandbox", options: { profile: "lane-3" } },
      effects: ["proc:spawn"],
      mode: "expected",
      tier: "compensable",
      onConflict: "lane",
      sealed: false
    },
    {
      id: "test",
      key: "key:test",
      kind: "step",
      placement: { tag: "sandbox", options: { profile: "lane-3" } },
      effects: ["proc:spawn", "fs:read"],
      sealed: false
    },
    {
      id: "review",
      key: "key:review",
      kind: "dynamic",
      placement: { tag: "remote", options: { profile: "reviewer" } },
      effects: ["model:reviewer"],
      mode: "hermetic",
      tier: "sealed",
      onConflict: "serialize",
      sealed: true,
      envelope: {
        budget: { tokens: 300_000 },
        flows: ["read-pr", "lint", "test"]
      }
    }
  ],
  edges: [
    { from: "read-pr", to: "test" },
    { from: "read-pr", to: "lint" },
    { from: "lint", to: "review" },
    { from: "test", to: "review" }
  ]
}

const assertFailure = (assertion: Effect.Effect<void, { readonly code: string }>, code: string) =>
  assertion.pipe(
    Effect.flip,
    Effect.tap((error) => Effect.sync(() => expect(error.code).toBe(code))),
    Effect.asVoid
  )

describe("PlanAssertions", () => {
  it.effect("asserts node counts and node membership", () =>
    Effect.gen(function*() {
      yield* expectPlan(plan).nodeCount(4)
      yield* expectPlan(plan).contains("review")
      yield* assertFailure(expectPlan(plan).nodeCount(3), "node_count_mismatch")
      yield* assertFailure(expectPlan(plan).contains("missing"), "missing_node")
    }))

  it.effect("asserts required and exact graph edges", () =>
    Effect.gen(function*() {
      yield* expectPlan(plan).edges([{ from: "read-pr", to: "lint" }])
      yield* expectPlan(plan).edges([
        ["read-pr", "lint"],
        ["read-pr", "test"],
        ["lint", "review"],
        ["test", "review"]
      ], { exact: true })
      yield* assertFailure(expectPlan(plan).edges([["review", "publish"]]), "missing_edge")
      yield* assertFailure(expectPlan(plan).edges([["read-pr", "lint"]], { exact: true }), "unexpected_edge")
    }))

  it.effect("asserts keys, placements, declared effects, and envelopes", () =>
    Effect.gen(function*() {
      yield* expectPlan(plan).keys({ "read-pr": "key:read-pr", review: "key:review" })
      yield* expectPlan(plan).placement("review", "remote")
      yield* expectPlan(plan).placement("review", { tag: "remote", options: { profile: "reviewer" } })
      yield* expectPlan(plan).declaresEffects("test", ["fs:read", "proc:spawn"])
      yield* expectPlan(plan).envelope({
        deny: ["proc:spawn"],
        may: ["fs:read ./", "net:get api.github.com"]
      })
      yield* assertFailure(expectPlan(plan).keys({ review: "key:wrong" }), "key_mismatch")
      yield* assertFailure(expectPlan(plan).placement("review", "local"), "placement_mismatch")
      yield* assertFailure(
        expectPlan(plan).placement("review", { tag: "remote", options: { profile: "other" } }),
        "placement_mismatch"
      )
      yield* assertFailure(expectPlan(plan).declaresEffects("test", ["fs:read"]), "declared_effect_mismatch")
      yield* assertFailure(expectPlan(plan).envelope({ deny: [] }), "envelope_mismatch")
    }))

  it.effect("scopes assertions to an individual node", () =>
    Effect.gen(function*() {
      const review = expectPlan(plan).node("review")
      yield* review.key("key:review")
      yield* review.placement("remote")
      yield* review.placement({ tag: "remote", options: { profile: "reviewer" } })
      yield* review.mode("hermetic")
      yield* review.tier("sealed")
      yield* review.onConflict("serialize")
      yield* review.declaresEffects(["model:reviewer"])
      yield* review.envelope({ budget: { tokens: 300_000 }, flows: ["read-pr", "lint", "test"] })
      yield* assertFailure(review.key("key:other"), "key_mismatch")
      yield* assertFailure(review.placement("local"), "placement_mismatch")
      yield* assertFailure(review.mode("expected"), "declared_effect_mismatch")
      yield* assertFailure(review.tier("irreversible"), "declared_effect_mismatch")
      yield* assertFailure(review.onConflict("fail"), "declared_effect_mismatch")
      yield* assertFailure(review.declaresEffects([]), "declared_effect_mismatch")
      yield* assertFailure(review.envelope({}), "envelope_mismatch")
      yield* assertFailure(expectPlan(plan).node("missing").key("key:none"), "missing_node")
      const lint = expectPlan(plan).node("lint")
      yield* lint.mode("expected")
      yield* lint.tier("compensable")
      yield* lint.onConflict("lane")
      yield* expectPlan(plan).node("test").mode(undefined)
    }))

  it.effect("renders a stable snapshot and fails with a readable diff", () =>
    Effect.gen(function*() {
      const snapshot = Plan.render(plan)
      yield* expectPlan(plan).matchesSnapshot(snapshot)
      // Deterministic: node/edge order in the input must not matter.
      const shuffled: PlanLike = {
        ...plan,
        nodes: [...plan.nodes].reverse(),
        edges: [...plan.edges].reverse()
      }
      expect(Plan.render(shuffled)).toBe(snapshot)
      const error = yield* expectPlan(shuffled).matchesSnapshot(snapshot.replace("key:review", "key:changed")).pipe(
        Effect.flip
      )
      expect(error.code).toBe("snapshot_mismatch")
      expect(error.message).toContain("- ")
      expect(error.message).toContain("+ ")
      expect(error.message).toContain("key:changed")
    }))

  it.effect("checks key goldens and reports drift as a cache-identity break", () =>
    Effect.gen(function*() {
      yield* expectKeyGoldens({ a: "key1_aa", b: "key1_bb" }, { a: "key1_aa" })
      const error = yield* expectKeyGoldens({ a: "sk1_aa" }, { a: "sk1_other" }).pipe(Effect.flip)
      expect(error.code).toBe("key_golden_mismatch")
    }))

  it.effect("surfaces impure plan computations as purity violations", () =>
    Effect.gen(function*() {
      const pure = yield* expectPure(Effect.succeed(plan))
      expect(pure).toBe(plan)
      const error = yield* expectPure(Effect.fail("touched the filesystem")).pipe(Effect.flip)
      expect(error.code).toBe("purity_violation")
    }))

  it.effect("checks static coverage over a suite of plans", () =>
    Effect.gen(function*() {
      const alternate: PlanLike = { ...plan, nodes: plan.nodes.filter((node) => node.id !== "review") }
      yield* expectPlans([alternate, plan]).covers(["read-pr", "review"])
      yield* expectPlans([alternate]).covers(["review"], { allowUnreached: ["review"] })
      yield* assertFailure(expectPlans([alternate]).covers(["review"]), "coverage_mismatch")
    }))
})
