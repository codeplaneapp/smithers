import { describe, it } from "@effect/vitest"
import * as Core from "@smthrs/core"
import * as Digest from "@smthrs/core/Digest"
import * as StepKey from "@smthrs/plan/StepKey"
import * as Effect from "effect/Effect"
import { expect } from "vitest"
import * as Plan from "../src/Plan.ts"
import { expectKeyGoldens } from "../src/PlanAssertions.ts"
import goldens from "./fixtures/key-goldens.json" with { type: "json" }

// Checked-in golden digests for canonical key serialization: the same logical
// input must keep producing byte-identical keys across releases. A mismatch
// here is a cache-identity break, never a test to re-record casually.
//
// The goldens were re-pinned once, deliberately, when the agent side moved off
// the deleted `@smthrs/keys/StepKey` and onto `@smthrs/plan`'s revived
// compiler. That compiler emits `@smthrs/keys` `Key` values — `key1_` over
// canonical JSON — instead of the old private `sk1_` digest format, because the
// engine dispatches under `Key` and a plan keyed in a second format could never
// be the thing the step cache is consulted against. Same material, same hash,
// one namespace: the values below are the first pinning of the new format.
// The graph root was re-pinned deliberately after `@smthrs/plan` moved
// function identities from FNV-1a source hashes to SHA-256 source hashes. The
// leaf keys are unchanged; only the parent plan material includes that identity.
//
// It was re-pinned a second time, also deliberately, when graph identity became
// injective and stopped reading caller-owned state. That change gave undefined,
// -0, accessors, and several Effect instances their own encodings, so it moved
// key material to `flows/key-material/v2` and captured-function identity to
// `sha256-source-captures/v4` precisely so no hardened encoding could alias a
// key its predecessor produced. All three graph keys moved, the leaves included,
// because the same change re-encodes the effect declarations and placements a
// leaf is keyed on. The two StepKey digests are unchanged, since neither reads
// graph material.

const buildGraph = (): Core.Graph.Graph => {
  const read = Core.Node.dynamic({
    model: "recorded:reader",
    effects: Core.Effects.make({
      reads: ["workspace/pr.json"],
      writes: [],
      mode: "hermetic",
      onConflict: "serialize",
      tier: "sealed"
    })
  }).pipe(Core.Node.within(Core.Placement.local()))
  const review = Core.Node.dynamic({
    model: "recorded:reviewer",
    effects: Core.Effects.make({
      reads: [],
      writes: ["workspace/review.json"],
      mode: "hermetic",
      onConflict: "serialize",
      tier: "sealed"
    })
  }).pipe(Core.Node.within(Core.Placement.remote({ profile: "reviewer" })))
  return Core.Graph.build(Core.Node.all({ read, review }))
}

const actualKeys = (): Record<string, string> => {
  const keys = Plan.keys(buildGraph())
  const runKey = <A, E>(effect: Effect.Effect<A, E, import("effect/Crypto").Crypto>): A =>
    Effect.runSync(Digest.provideSync(effect))
  return {
    "content/basic": runKey(
      StepKey.content({ body: "x", inputs: {}, layers: [], capabilities: {} })
    ),
    "ordinal/basic": runKey(
      StepKey.ordinal({ runId: "golden-run", ordinal: 0, tier: "unsealed" })
    ),
    "graph/root": keys["root"]!,
    "graph/root.all.read": keys["root.all.read"]!,
    "graph/root.all.review": keys["root.all.review"]!
  }
}

describe("key goldens", () => {
  it.effect("reproduces the checked-in golden digests byte-for-byte", () =>
    Effect.gen(function*() {
      yield* expectKeyGoldens(actualKeys(), goldens)
    }))

  it.effect("stays byte-identical across independent derivations", () =>
    Effect.gen(function*() {
      expect(actualKeys()).toEqual(actualKeys())
      yield* expectKeyGoldens(actualKeys(), goldens)
    }))

  it.effect("reports drift with the key_golden_mismatch code", () =>
    Effect.gen(function*() {
      const error = yield* expectKeyGoldens(actualKeys(), {
        "graph/root": "key1_0000000000000000000000000000000000000000000000000000000000000000"
      }).pipe(Effect.flip)
      expect(error.code).toBe("key_golden_mismatch")
      expect(error.message).toContain("cache-identity break")
    }))
})
