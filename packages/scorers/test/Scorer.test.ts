import * as Effect from "effect/Effect"
import { describe, expect, it } from "vitest"
import * as Scorer from "../src/Scorer.ts"

describe("Scorer", () => {
  it("has an independent declaration key and validates scores", async () => {
    const scorer = Scorer.make({
      id: "packages/scorers/test/Scorer/quality",
      version: "1",
      name: "quality",
      score: () => Effect.succeed({ score: 1 })
    })
    expect(scorer.scorerKey).toMatch(/^[0-9a-f]{64}$/)
    await expect(
      Effect.runPromise(Scorer.validate({ score: 2, reason: "bad" }))
    ).rejects.toMatchObject({ code: "invalid_score" })
  })

  it("uses explicit identity and canonical configuration, never closure source", () => {
    const make = (score: number, config: unknown) =>
      Scorer.make({
        id: "packages/scorers/test/Scorer/configured",
        version: "2",
        config,
        score: () => Effect.succeed({ score })
      })
    expect(make(0, { b: 2, a: 1 }).scorerKey).toBe(make(1, { a: 1, b: 2 }).scorerKey)
    expect(make(0, { a: 1 }).scorerKey).not.toBe(make(0, { a: 2 }).scorerKey)
  })
})
