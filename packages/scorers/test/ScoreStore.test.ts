import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { describe, expect, it } from "vitest"
import * as ScoreStore from "../src/ScoreStore.ts"
import * as SqlScoreStore from "../src/SqlScoreStore.ts"

describe("ScoreStore", () => {
  it("retains repeated observations and atomically records jobs once", async () => {
    const program = Effect.gen(function*() {
      const store = yield* ScoreStore.ScoreStore
      yield* store.record({
        kind: "score",
        targetStepKey: "a",
        scorerKey: "s",
        score: 1,
        reason: "one",
        at: 1
      })
      yield* store.record({
        kind: "score",
        targetStepKey: "a",
        scorerKey: "s",
        score: 0,
        reason: "zero",
        at: 2
      })
      yield* store.record({
        kind: "inconclusive",
        targetStepKey: "a",
        scorerKey: "s",
        reason: "unavailable",
        at: 3
      })
      return {
        observations: yield* store.observations("a", "s"),
        aggregate: yield* store.aggregate("a", "s"),
        first: yield* store.recordOnce("job", {
          kind: "score",
          targetStepKey: "a",
          scorerKey: "s",
          score: 0.75,
          at: 4
        }),
        second: yield* store.recordOnce("job", {
          kind: "score",
          targetStepKey: "a",
          scorerKey: "s",
          score: 0.25,
          at: 5
        })
      }
    })
    const layer = SqlScoreStore.layer.pipe(Layer.provide(TestDatabase.layer))
    const output = await Effect.runPromise(Effect.provide(program, layer))
    expect(output.observations).toHaveLength(3)
    expect(output.observations[2]).toMatchObject({ kind: "inconclusive" })
    expect(output.aggregate).toEqual({ count: 2, mean: 0.5, min: 0 })
    expect([output.first, output.second]).toEqual([true, false])
  })

  it("rolls back a job claim when observation recording fails", async () => {
    const program = Effect.gen(function*() {
      const store = yield* ScoreStore.ScoreStore
      const failed = yield* Effect.exit(store.recordOnce("retryable", {
        kind: "score",
        targetStepKey: "a",
        scorerKey: "s",
        score: 2,
        at: 1
      }))
      const retried = yield* store.recordOnce("retryable", {
        kind: "score",
        targetStepKey: "a",
        scorerKey: "s",
        score: 1,
        at: 2
      })
      return { failed, retried }
    })
    const layer = SqlScoreStore.layer.pipe(Layer.provide(TestDatabase.layer))
    const output = await Effect.runPromise(Effect.provide(program, layer))
    expect(output.failed._tag).toBe("Failure")
    expect(output.retried).toBe(true)
  })
})
