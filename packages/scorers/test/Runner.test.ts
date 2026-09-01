import { Cause, Deferred, Effect, Exit, Fiber } from "effect"
import * as Logger from "effect/Logger"
import { describe, expect, it } from "vitest"
import * as Runner from "../src/Runner.ts"
import * as RunnerLive from "../src/RunnerLive.ts"
import { ScorerError } from "../src/ScorerError.ts"
import * as ScoreStore from "../src/ScoreStore.ts"

interface Recorder {
  readonly store: ScoreStore.Service
  readonly seen: Array<{ readonly identity: string; readonly observation: ScoreStore.Observation }>
}

const recorder = (
  recordOnce?: (identity: string, observation: ScoreStore.Observation) => Effect.Effect<boolean, ScorerError>
): Recorder => {
  const seen: Recorder["seen"] = []
  return {
    seen,
    store: ScoreStore.make({
      record: () => Effect.void,
      recordOnce: (identity, observation) =>
        recordOnce === undefined
          ? Effect.sync(() => {
            seen.push({ identity, observation })
            return true
          })
          : recordOnce(identity, observation),
      observations: () => Effect.succeed([]),
      aggregate: () => Effect.succeed(undefined)
    })
  }
}

const withRunner = <A>(
  store: ScoreStore.Service,
  program: (runner: Runner.Service) => Effect.Effect<A>,
  options?: RunnerLive.Options
) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function*() {
        const runner = yield* Runner.Runner
        return yield* program(runner)
      }).pipe(
        Effect.provide(RunnerLive.layer(options)),
        Effect.provideService(ScoreStore.ScoreStore, store)
      )
    )
  )

const job = (overrides: Partial<Runner.Job> = {}): Runner.Job => ({
  identity: "job",
  observation: { targetStepKey: "t", scorerKey: "s" },
  score: Effect.succeed({ score: 1 }),
  at: 1,
  ...overrides
})

describe("Runner", () => {
  it("turns scorer failures into typed inconclusive observations", async () => {
    const sink = recorder()
    const output = await withRunner(sink.store, (runner) => runner.runBatch([job({ score: Effect.fail("boom") })]))
    // The observation has to name what went wrong. A fixed sentence made a
    // scorer bug and an unreachable judge produce the same record, and this
    // reason is the only prose field a reader downstream ever sees.
    expect(output[0]).toMatchObject({
      kind: "inconclusive",
      code: "inconclusive",
      reason: expect.stringContaining("boom")
    })
    expect(sink.seen.map((entry) => entry.observation)).toEqual(output)
  })

  it("classifies a scorer that returned an out-of-contract score", async () => {
    const sink = recorder()
    const output = await withRunner(
      sink.store,
      (runner) => runner.runBatch([job({ score: Effect.succeed({ score: 2 }) })])
    )
    expect(output[0]).toMatchObject({ kind: "inconclusive", code: "invalid_score" })
  })

  it("records a score with its reason and metadata", async () => {
    const sink = recorder()
    const output = await withRunner(
      sink.store,
      (runner) => runner.runBatch([job({ score: Effect.succeed({ score: 0.5, reason: "close", meta: { n: 1 } }) })])
    )
    expect(output[0]).toEqual({
      kind: "score",
      targetStepKey: "t",
      scorerKey: "s",
      score: 0.5,
      reason: "close",
      meta: { n: 1 },
      at: 1
    })
  })

  it("truncates a scorer reason to the durable bound", async () => {
    const sink = recorder()
    const output = await withRunner(
      sink.store,
      (runner) => runner.runBatch([job({ score: Effect.succeed({ score: 1, reason: "x".repeat(4_000) }) })])
    )
    const [observation] = output
    expect(observation?.kind).toBe("score")
    expect(observation?.reason).toHaveLength(ScoreStore.maxReasonBytes)
  })

  it("reports and logs a failed durable write by job identity", async () => {
    const logged: Array<unknown> = []
    const capture = Logger.make<unknown, void>(({ message }) => {
      logged.push(message)
    })
    const sink = recorder(() => Effect.fail(new ScorerError({ code: "store", message: "no room" })))
    const output = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          const runner = yield* Runner.Runner
          return yield* runner.runBatchCorrelated([job()])
        }).pipe(
          Effect.provide(RunnerLive.layer()),
          Effect.provideService(ScoreStore.ScoreStore, sink.store),
          Effect.provide(Logger.layer([capture]))
        )
      )
    )
    expect(output).toMatchObject([{
      identity: "job",
      observation: { targetStepKey: "t", scorerKey: "s", kind: "score", score: 1, at: 1 },
      recorded: "failed"
    }])
    const written = JSON.stringify(logged)
    expect(written).toContain("Could not record a scorer observation")
    // The cause has to travel with the line. Naming only the sentence would
    // leave a reader unable to tell a full disk from a rejected observation.
    expect(written).toContain("no room")
  })

  it("correlates persisted and duplicate observations by job identity", async () => {
    const claimed = new Set(["duplicate"])
    const sink = recorder((identity) =>
      Effect.sync(() => {
        if (claimed.has(identity)) return false
        claimed.add(identity)
        return true
      })
    )
    const output = await withRunner(
      sink.store,
      (runner) =>
        runner.runBatchCorrelated([
          job({ identity: "fresh", at: 1 }),
          job({ identity: "duplicate", at: 2 })
        ]),
      { concurrency: 1 }
    )
    expect(output.map(({ identity, recorded }) => ({ identity, recorded }))).toEqual([
      { identity: "fresh", recorded: "persisted" },
      { identity: "duplicate", recorded: "duplicate" }
    ])
    expect(output.map((outcome) => outcome.observation.at)).toEqual([1, 2])
  })

  it("returns runBatch observations in job order", async () => {
    const sink = recorder()
    const output = await withRunner(
      sink.store,
      (runner) =>
        runner.runBatch([
          job({ identity: "slow", score: Effect.sleep("10 millis").pipe(Effect.as({ score: 0.25 })), at: 1 }),
          job({ identity: "fast", score: Effect.succeed({ score: 0.75 }), at: 2 })
        ], { concurrency: 2 })
    )
    expect(output.map((observation) => observation.kind === "score" ? observation.score : undefined)).toEqual([
      0.25,
      0.75
    ])
  })

  it("propagates fiber interruption rather than recording an inconclusive observation", async () => {
    const sink = recorder()
    const exit = await withRunner(
      sink.store,
      (runner) => Effect.exit(runner.runBatch([job({ score: Effect.interrupt })]))
    )
    expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
    expect(sink.seen).toEqual([])
  })

  it("snapshots a submitted job so a later mutation cannot change what is recorded", async () => {
    const sink = recorder()
    const recorded = await withRunner(sink.store, (runner) =>
      Effect.gen(function*() {
        const mutable = { identity: "first", observation: { targetStepKey: "t", scorerKey: "s" }, at: 1 }
        yield* runner.submit({ ...mutable, score: Effect.succeed({ score: 1 }) } as Runner.Job)
        mutable.identity = "second"
        mutable.observation.targetStepKey = "moved"
        mutable.at = 99
        yield* Effect.sleep("50 millis")
        return sink.seen
      }))
    expect(recorded).toHaveLength(1)
    expect(recorded[0]?.identity).toBe("first")
    expect(recorded[0]?.observation).toMatchObject({ targetStepKey: "t", at: 1 })
  })

  it("starts every configured worker and backpressures at the queue bound", async () => {
    const sink = recorder()
    const output = await withRunner(sink.store, (runner) =>
      Effect.gen(function*() {
        const release = yield* Deferred.make<void>()
        const twoEntered = yield* Deferred.make<void>()
        let entered = 0
        const blocking = (identity: string): Runner.Job => ({
          identity,
          observation: { targetStepKey: identity, scorerKey: "s" },
          at: 1,
          score: Effect.sync(() => {
            entered += 1
            if (entered === 2) Deferred.doneUnsafe(twoEntered, Effect.void)
          }).pipe(Effect.andThen(Deferred.await(release)), Effect.as({ score: 1 }))
        })
        yield* runner.submit(blocking("one"))
        yield* runner.submit(blocking("two"))
        yield* Deferred.await(twoEntered)
        yield* runner.submit(blocking("three"))
        const fourth = yield* runner.submit(blocking("four")).pipe(Effect.forkChild({ startImmediately: true }))
        yield* Effect.yieldNow
        const blocked = yield* Effect.sync(() => fourth.pollUnsafe() === undefined)
        yield* Deferred.succeed(release, void 0)
        yield* Fiber.join(fourth)
        return { startedConcurrently: entered >= 2, blocked }
      }), { concurrency: 2, capacity: 1 })
    expect(output).toEqual({ startedConcurrently: true, blocked: true })
  })

  it("coerces worker options that are not positive safe integers", async () => {
    const sink = recorder()
    // Documented behavior, not an accident: the layer's error channel is
    // `never`, so an unusable value falls back to the default rather than
    // failing a run that has already started.
    const output = await withRunner(
      sink.store,
      (runner) => runner.runBatch([job()], { concurrency: -5 }),
      { concurrency: 0, capacity: 0 }
    )
    expect(output).toHaveLength(1)
  })

  describe("inconclusive", () => {
    it("carries a scorer error's own code", () => {
      const observation = Runner.inconclusive(
        job(),
        Cause.fail(new ScorerError({ code: "invalid_sampling", message: "bad" }))
      )
      expect(observation).toMatchObject({ kind: "inconclusive", code: "invalid_sampling" })
    })

    it("survives a cause that cannot be coerced to a string", () => {
      const hostile = {
        toString: () => {
          throw new TypeError("no")
        }
      }
      const observation = Runner.inconclusive(job(), hostile)
      expect(observation).toMatchObject({
        kind: "inconclusive",
        code: "inconclusive",
        reason: "Scorer execution was inconclusive: <uncoercible cause>"
      })
    })

    it("truncates an enormous cause on a code-point boundary", () => {
      const observation = Runner.inconclusive(job(), "é".repeat(4_000))
      const reason = observation.kind === "inconclusive" ? observation.reason : ""
      const bytes = new TextEncoder().encode(reason)
      expect(bytes.length).toBeLessThanOrEqual(ScoreStore.maxReasonBytes)
      expect(bytes.length).toBeGreaterThan(ScoreStore.maxReasonBytes - 2)
      // A truncation that split the two-byte sequence would decode to U+FFFD
      // and be stored as corruption.
      expect(reason.endsWith("é")).toBe(true)
      expect(reason).not.toContain("�")
    })
  })

  describe("jobIdentity", () => {
    it("cannot collide across component boundaries", () => {
      expect(Runner.jobIdentity(["a:b", "c"])).not.toBe(Runner.jobIdentity(["a", "b:c"]))
      expect(Runner.jobIdentity(["a", "b"])).toBe(Runner.jobIdentity(["a", "b"]))
      expect(Runner.jobIdentity([])).toBe("v1")
    })
  })

  describe("makeNoop", () => {
    it("accepts submissions and returns no observations", async () => {
      const noop = Runner.makeNoop()
      await Effect.runPromise(noop.submit(job()))
      expect(await Effect.runPromise(noop.runBatch([job()]))).toEqual([])
      expect(await Effect.runPromise(noop.runBatchCorrelated([job()]))).toEqual([])
    })

    it("is provided by layerNoop", async () => {
      const output = await Effect.runPromise(
        Effect.gen(function*() {
          const runner = yield* Runner.Runner
          return yield* runner.runBatch([job()])
        }).pipe(Effect.provide(Runner.layerNoop))
      )
      expect(output).toEqual([])
    })
  })
})
