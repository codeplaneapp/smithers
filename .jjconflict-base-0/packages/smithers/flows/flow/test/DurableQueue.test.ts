// Deep reviewed and polished by a human on 2026-08-10.

import { describe, expect, it } from "@effect/vitest"
import { Action, DurableDeferred, DurableQueue, Flow, FlowRuntime, Interpreter } from "@smthrs/flow"
import { Cause, Effect, Exit, Layer, Logger, Option, Schema } from "effect"
import type * as Crypto from "effect/Crypto"
import { TestClock } from "effect/testing"
import { PersistedQueue } from "effect/unstable/persistence"
import { withCrypto } from "./Crypto.ts"
import { layerMemory } from "./MemoryFlowRuntime.ts"

const effect = (name: string, body: () => Effect.Effect<void, unknown, Crypto.Crypto>) =>
  it.effect(name, () => withCrypto(body().pipe(Effect.provide(TestClock.layer()))))

const PersistedQueueLayer = PersistedQueue.layer.pipe(
  Layer.provideMerge(PersistedQueue.layerStoreMemory)
)

const pollUntilComplete = <A, E, R>(
  poll: Effect.Effect<Option.Option<Flow.Result<A, E>>, FlowRuntime.FlowExecutionNotFound, R>
) =>
  Effect.gen(function*() {
    let result = yield* poll
    for (let i = 0; i < 10 && (Option.isNone(result) || result.value._tag !== "Complete"); i++) {
      yield* Effect.yieldNow
      yield* TestClock.adjust("10 millis")
      result = yield* poll
    }
    return result
  })

describe("DurableQueue", () => {
  const Queue = DurableQueue.make({
    name: "DurableQueue/SuppliedKey",
    payload: { id: Schema.String, value: Schema.Number },
    success: Schema.Number,
    error: Schema.String,
    idempotencyKey: ({ id }) => id
  })
  const Offer = Action.make("DurableQueue/SuppliedKey/offer", {
    payload: { id: Schema.String, value: Schema.Number },
    success: Schema.Number,
    error: Schema.String
  })
  const Flow_ = Flow.make("DurableQueue/SuppliedKey", {
    payload: { id: Schema.String, value: Schema.Number },
    success: Schema.Number,
    error: Schema.String,
    idempotencyKey: ({ id }) => id,
    body: (payload) => Offer.call(payload)
  })
  const successLayer = Layer.mergeAll(
    Offer.toLayer(({ id, value }) => DurableQueue.process(Queue, { id, value })),
    Interpreter.layer(Flow_),
    DurableQueue.worker(Queue, ({ value }) => Effect.succeed(value + 1))
  ).pipe(
    Layer.provideMerge(Action.layerImplementations),
    Layer.provideMerge(layerMemory),
    Layer.provideMerge(PersistedQueueLayer)
  )

  effect("processes queued work through the supplied-key engine seam", () =>
    Effect.gen(function*() {
      const executionId = yield* Flow_.execute({ id: "success", value: 41 }, { discard: true })
      const result = yield* pollUntilComplete(Flow_.poll(executionId))
      expect(Option.isSome(result) && result.value._tag === "Complete" && Exit.isSuccess(result.value.exit)).toBe(true)
      if (Option.isSome(result) && result.value._tag === "Complete" && Exit.isSuccess(result.value.exit)) {
        expect(result.value.exit.value).toBe(42)
      }
    }).pipe(Effect.provide(successLayer)))

  effect("propagates queue worker failures", () => {
    const Offer = Action.make("DurableQueue/Failure/offer", {
      payload: { id: Schema.String },
      success: Schema.Void,
      error: Schema.String
    })
    const Failure = Flow.make("DurableQueue/Failure", {
      payload: { id: Schema.String },
      success: Schema.Void,
      error: Schema.String,
      idempotencyKey: ({ id }) => id,
      body: (payload) => Offer.call(payload)
    })
    const layer = Layer.mergeAll(
      Offer.toLayer(({ id }) => DurableQueue.process(Queue, { id, value: 0 }).pipe(Effect.asVoid)),
      Interpreter.layer(Failure),
      DurableQueue.worker(Queue, () => Effect.fail("boom"))
    ).pipe(
      Layer.provideMerge(Action.layerImplementations),
      Layer.provideMerge(layerMemory),
      Layer.provideMerge(PersistedQueueLayer)
    )

    return Effect.gen(function*() {
      const executionId = yield* Failure.execute({ id: "failure" }, { discard: true })
      const result = yield* pollUntilComplete(Failure.poll(executionId))
      expect(Option.isSome(result) && result.value._tag === "Complete" && Exit.isFailure(result.value.exit)).toBe(true)
      if (Option.isSome(result) && result.value._tag === "Complete" && Exit.isFailure(result.value.exit)) {
        expect(result.value.exit.cause.reasons.find(Cause.isFailReason)?.error).toBe("boom")
      }
    }).pipe(Effect.provide(layer))
  })

  effect("accepts an already-built payload schema as well as a field record", () => {
    // `make` adopts a schema as-is and wraps a field record; both forms must
    // round-trip an item through a worker identically.
    const payloadSchema = Schema.Struct({ id: Schema.String, value: Schema.Number })
    const SchemaQueue = DurableQueue.make({
      name: "DurableQueue/SchemaPayload",
      payload: payloadSchema,
      success: Schema.Number,
      error: Schema.String,
      idempotencyKey: ({ id }) => id
    })
    expect(SchemaQueue.payloadSchema).toBe(payloadSchema)

    const Offer = Action.make("DurableQueue/SchemaPayload/offer", {
      payload: { id: Schema.String, value: Schema.Number },
      success: Schema.Number,
      error: Schema.String
    })
    const SchemaFlow = Flow.make("DurableQueue/SchemaPayload", {
      payload: { id: Schema.String, value: Schema.Number },
      success: Schema.Number,
      error: Schema.String,
      idempotencyKey: ({ id }) => id,
      body: (payload) => Offer.call(payload)
    })
    const layer = Layer.mergeAll(
      Offer.toLayer(({ id, value }) => DurableQueue.process(SchemaQueue, { id, value })),
      Interpreter.layer(SchemaFlow),
      DurableQueue.worker(SchemaQueue, ({ value }) => Effect.succeed(value * 2))
    ).pipe(
      Layer.provideMerge(Action.layerImplementations),
      Layer.provideMerge(layerMemory),
      Layer.provideMerge(PersistedQueueLayer)
    )

    return Effect.gen(function*() {
      const executionId = yield* SchemaFlow.execute({ id: "schema", value: 21 }, { discard: true })
      const result = yield* pollUntilComplete(SchemaFlow.poll(executionId))
      expect(
        Option.isSome(result) && result.value._tag === "Complete" && Exit.isSuccess(result.value.exit) &&
          result.value.exit.value
      ).toBe(42)
    }).pipe(Effect.provide(layer))
  })

  it("refuses invalid concurrency before opening the persisted queue", () => {
    const declare = (concurrency: number) => () =>
      DurableQueue.makeWorker(Queue, () => Effect.succeed(0), { concurrency })

    for (const invalid of [-1, 0, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(declare(invalid)).toThrow(RangeError)
      expect(declare(invalid)).toThrow(/concurrency/)
      expect(declare(invalid)).toThrow(String(invalid))
    }
    expect(declare(Number.MAX_SAFE_INTEGER)).not.toThrow()
  })

  effect("logs a malformed item token at error and continues the worker loop", () => {
    const WorkerQueue = DurableQueue.make({
      name: "DurableQueue/MalformedWorker",
      payload: { id: Schema.String, value: Schema.Number },
      success: Schema.Number,
      error: Schema.String,
      idempotencyKey: ({ id }) => id
    })
    const itemSchema = Schema.Struct({
      token: DurableDeferred.Token,
      payload: WorkerQueue.payloadSchema,
      traceId: Schema.String,
      spanId: Schema.String,
      sampled: Schema.Boolean
    })
    const logs: Array<{ readonly level: string; readonly message: string }> = []
    const capture = Logger.make((entry) => {
      logs.push({ level: entry.logLevel, message: String(entry.message) })
    })
    let handled = 0

    return Effect.gen(function*() {
      const queue = yield* PersistedQueue.make({
        name: `DurableQueue/${WorkerQueue.name}`,
        schema: itemSchema
      })
      yield* Effect.forkChild(
        DurableQueue.makeWorker(
          WorkerQueue,
          ({ value }) => Effect.sync(() => (handled++, value + 1))
        ),
        { startImmediately: true }
      )
      yield* queue.offer({
        token: "*".repeat(100) as DurableDeferred.Token,
        payload: { id: "bad", value: 1 },
        traceId: "0".repeat(32),
        spanId: "0".repeat(16),
        sampled: false
      }, { id: "bad" })
      for (let turn = 0; turn < 50 && !logs.some((entry) => entry.level === "Error"); turn++) {
        yield* Effect.yieldNow
      }

      const completion = DurableDeferred.make(`${WorkerQueue.deferred.name}/valid`, {
        success: WorkerQueue.deferred.successSchema,
        error: WorkerQueue.deferred.errorSchema
      })
      const token = new DurableDeferred.TokenParsed({
        flowName: "DurableQueue/MalformedWorker/Host",
        executionId: "worker",
        deferredName: completion.name
      }).asToken
      yield* queue.offer({
        token,
        payload: { id: "valid", value: 41 },
        traceId: "1".repeat(32),
        spanId: "1".repeat(16),
        sampled: false
      }, { id: "valid" })
      for (let turn = 0; turn < 50 && handled === 0; turn++) yield* Effect.yieldNow

      expect(handled).toBe(1)
      const reported = logs.find((entry) => entry.level === "Error")
      expect(reported?.message).toContain(WorkerQueue.name)
      expect(reported?.message).toContain("64")
      expect(reported?.message).toContain("characters dropped")
    }).pipe(
      Effect.provide(Logger.layer([capture])),
      Effect.provide(layerMemory),
      Effect.provide(PersistedQueueLayer)
    )
  })

  effect("backs off before retrying a persistently failing take", () => {
    const logs: Array<{ readonly level: string; readonly message: string }> = []
    const capture = Logger.make((entry) => {
      logs.push({ level: entry.logLevel, message: String(entry.message) })
    })
    const store = PersistedQueue.PersistedQueueStore.of({
      offer: () => Effect.void,
      take: () => Effect.fail(new PersistedQueue.PersistedQueueError({ message: "take unavailable" }))
    })
    const failingQueueLayer = PersistedQueue.layer.pipe(
      Layer.provide(Layer.succeed(PersistedQueue.PersistedQueueStore)(store))
    )

    return Effect.gen(function*() {
      yield* Effect.forkChild(
        DurableQueue.makeWorker(Queue, () => Effect.succeed(0)),
        { startImmediately: true }
      )
      for (let turn = 0; turn < 50 && logs.length === 0; turn++) yield* Effect.yieldNow
      expect(logs.filter((entry) => entry.level === "Warn")).toHaveLength(1)

      yield* TestClock.adjust("499 millis")
      expect(logs.filter((entry) => entry.level === "Warn")).toHaveLength(1)
      yield* TestClock.adjust("1 milli")
      for (let turn = 0; turn < 50 && logs.length === 1; turn++) yield* Effect.yieldNow
      expect(logs.filter((entry) => entry.level === "Warn")).toHaveLength(2)
    }).pipe(
      Effect.provide(Logger.layer([capture])),
      Effect.provide(layerMemory),
      Effect.provide(failingQueueLayer)
    )
  })
})
