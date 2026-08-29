import * as Flow from "@smthrs/core/Flow"
import * as Effect from "effect/Effect"
import { describe, expect, it } from "vitest"
import * as Binding from "../src/Binding.ts"
import * as Scorer from "../src/Scorer.ts"

describe("Binding", () => {
  it("does not modify the target declaration", () => {
    const target = Flow.make({ name: "target" })
    const scorer = Scorer.make({
      id: "packages/scorers/test/Binding/score",
      version: "1",
      name: "score",
      score: () => Effect.succeed({ score: 1 })
    })
    const binding = Binding.make({
      scorer,
      appliesTo: target,
      groundTruth: "expected",
      context: { rubric: "exact" }
    })
    expect(binding.appliesTo).toBe(target)
    expect(binding.sampling).toBe("all")
    expect(binding.context).toEqual({ rubric: "exact" })
    expect(target.name).toBe("target")
  })
})
