import { Deferred, Effect, Fiber } from "effect"
import { describe, expect, it } from "vitest"
import * as Runner from "../src/Runner.ts"
import * as RunnerLive from "../src/RunnerLive.ts"
import * as ScoreStore from "../src/ScoreStore.ts"

describe("Runner", () => {
  it("turns scorer failures into typed inconclusive observations", async () => {
    const seen: Array<ScoreStore.Observation> = []
    const store = ScoreStore.make({
      record: (value) =>
        Effect.sync(() => {
          seen.push(value)
        }),
      recordOnce: (_identity, value) =>
        Effect.sync(() => {
          seen.push(value)
          return true
        }),
      observations: () => Effect.succeed([]),
      aggregate: () => Effect.succeed(undefined)
    })
    const program = Effect.gen(function*() {
      const runner = yield* Runner.Runner
      return yield* runner.runBatch([{
        identity: "job",
        observation: { targetStepKey: "t", scorerKey: "s" },
        score: Effect.fail("boom"),
        at: 1
      }])
    })
    const output = await Effect.runPromise(
      Effect.scoped(
        program.pipe(
          Effect.provide(RunnerLive.layer()),
          Effect.provideService(ScoreStore.ScoreStore, store)
        )
      )
    )
    // The observation has to name what went wrong. A fixed sentence made a
    // scorer bug and an unreachable judge produce the same record, and this
    // reason is the only field a reader downstream ever sees.
    expect(output[0]).toMatchObject({ kind: "inconclusive", reason: expect.stringContaining("boom") })
    expect(seen).toEqual(output)
  })

  it("starts every configured worker and backpressures at the queue bound", async () => {
    const store = ScoreStore.make({
      record: () => Effect.void,
      recordOnce: () => Effect.succeed(true),
      observations: () => Effect.succeed([]),
      aggregate: () => Effect.succeed(undefined)
    })
    const program = Effect.gen(function*() {
      const runner = yield* Runner.Runner
      const release = yield* Deferred.make<void>()
      const twoEntered = yield* Deferred.make<void>()
      let entered = 0
      const job = (identity: string): Runner.Job => ({
        identity,
        observation: { targetStepKey: identity, scorerKey: "s" },
        at: 1,
        score: Effect.sync(() => {
          entered += 1
          if (entered === 2) Deferred.doneUnsafe(twoEntered, Effect.void)
        }).pipe(Effect.andThen(Deferred.await(release)), Effect.as({ score: 1 }))
      })
      yield* runner.submit(job("one"))
      yield* runner.submit(job("two"))
      yield* Deferred.await(twoEntered)
      yield* runner.submit(job("three"))
      const fourth = yield* runner.submit(job("four")).pipe(Effect.forkChild({ startImmediately: true }))
      yield* Effect.yieldNow
      const blocked = yield* Effect.sync(() => fourth.pollUnsafe() === undefined)
      yield* Deferred.succeed(release, void 0)
      yield* Fiber.join(fourth)
      return { startedConcurrently: entered >= 2, blocked }
    })
    const output = await Effect.runPromise(
      Effect.scoped(
        program.pipe(
          Effect.provide(RunnerLive.layer({ concurrency: 2, capacity: 1 })),
          Effect.provideService(ScoreStore.ScoreStore, store)
        )
      )
    )
    expect(output).toEqual({ startedConcurrently: true, blocked: true })
  })
})
