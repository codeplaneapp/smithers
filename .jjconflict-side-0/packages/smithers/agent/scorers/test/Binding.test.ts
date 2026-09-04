import * as Flow from "@smthrs/core/Flow"
import * as Effect from "effect/Effect"
import { describe, expect, it } from "vitest"
import * as Binding from "../src/Binding.ts"
import * as Scorer from "../src/Scorer.ts"

const scorer = () =>
  Scorer.make({
    id: "packages/smithers/agent/scorers/test/Binding/score",
    version: "1",
    name: "score",
    score: () => Effect.succeed({ score: 1 })
  })

describe("Binding", () => {
  it("does not modify the target declaration", () => {
    const target = Flow.make({ name: "target" })
    const binding = Binding.make({
      scorer: scorer(),
      appliesTo: target,
      groundTruth: "expected",
      context: { rubric: "exact" }
    })
    expect(binding.appliesTo).toBe(target)
    expect(binding.sampling).toBe("all")
    expect(binding.context).toEqual({ rubric: "exact" })
    expect(target.name).toBe("target")
  })

  it("keeps an explicit sampling policy", () => {
    const binding = Binding.make({
      scorer: scorer(),
      appliesTo: Flow.make({ name: "target" }),
      sampling: { ratio: 0.5, seed: "v1" }
    })
    expect(binding.sampling).toEqual({ ratio: 0.5, seed: "v1" })
  })

  it("retains context and ground truth by reference, as documented", () => {
    // Pinned, not endorsed: the copy is shallow and scoring runs later, so a
    // caller that mutates either object after binding changes what the scorer
    // sees. This test exists so that policy cannot change silently.
    const context = { rubric: "exact" }
    const groundTruth = { answer: 1 }
    const binding = Binding.make({
      scorer: scorer(),
      appliesTo: Flow.make({ name: "target" }),
      context,
      groundTruth
    })
    context.rubric = "loose"
    groundTruth.answer = 2
    expect(binding.context).toEqual({ rubric: "loose" })
    expect(binding.groundTruth).toEqual({ answer: 2 })
  })
})
