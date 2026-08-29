// Deep reviewed and polished by a human on 2026-08-10.

import { describe, expect, it } from "@effect/vitest"
import { Action, DurableQueue, Flow, FlowRuntime, Interpreter } from "@smthrs/flow"
import { Cause, Effect, Exit, Layer, Option, Schema } from "effect"
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

  effect("a worker with concurrency 0 starts no workers, so queued items are never consumed", () => {
    const IdleQueue = DurableQueue.make({
      name: "DurableQueue/Idle",
      payload: { id: Schema.String },
      success: Schema.Void,
      error: Schema.String,
      idempotencyKey: ({ id }) => id
    })
    const Offer = Action.make("DurableQueue/Idle/offer", {
      payload: { id: Schema.String },
      success: Schema.Void,
      error: Schema.String
    })
    const IdleFlow = Flow.make("DurableQueue/Idle", {
      payload: { id: Schema.String },
      success: Schema.Void,
      error: Schema.String,
      idempotencyKey: ({ id }) => id,
      body: (payload) => Offer.call(payload)
    })
    let handled = 0
    const layer = Layer.mergeAll(
      Offer.toLayer(({ id }) => DurableQueue.process(IdleQueue, { id }).pipe(Effect.asVoid)),
      Interpreter.layer(IdleFlow),
      DurableQueue.worker(
        IdleQueue,
        () => Effect.sync(() => void handled++),
        { concurrency: 0 }
      )
    ).pipe(
      Layer.provideMerge(Action.layerImplementations),
      Layer.provideMerge(layerMemory),
      Layer.provideMerge(PersistedQueueLayer)
    )

    return Effect.gen(function*() {
      const executionId = yield* IdleFlow.execute({ id: "idle" }, { discard: true })
      const result = yield* pollUntilComplete(IdleFlow.poll(executionId))
      expect(handled).toBe(0)
      expect(Option.isSome(result) && result.value._tag === "Complete").toBe(false)
    }).pipe(Effect.provide(layer))
  })
})
