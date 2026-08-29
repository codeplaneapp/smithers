/**
 * Every `Effect.fn` span in this package carries identifying attributes:
 * `Effect.annotateCurrentSpan` runs at the top of each operation, so a trace
 * viewer can tell which run a span operated on without reading its SQL.
 */
import { DurableWriter } from "@smthrs/database"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { Effect, Fiber, Layer, Metric, Tracer } from "effect"
import { TestClock } from "effect/testing"
import type * as SqlClient from "effect/unstable/sql/SqlClient"
import { describe, expect, it } from "vitest"
import * as Migrations from "../src/Migrations.ts"
import { RunStore } from "../src/RunStore.ts"
import * as RunStoreLive from "../src/RunStore.ts"

const migrated = <A, E>(effect: Effect.Effect<A, E, DurableWriter.DurableWriter | SqlClient.SqlClient | RunStore>) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(RunStoreLive.layer),
      Effect.provide(Migrations.layer),
      Effect.provide(TestDatabase.layer),
      Effect.provide(TestClock.layer()),
      Effect.provideService(Metric.MetricRegistry, new Map())
    )
  )

describe("SpanAnnotations", () => {
  it("annotates RunStore operation spans with the run id", async () => {
    const spans: Array<Tracer.NativeSpan> = []
    const tracer = Tracer.make({
      span(options) {
        const span = new Tracer.NativeSpan(options)
        spans.push(span)
        return span
      }
    })

    await migrated(
      Effect.gen(function*() {
        const store = yield* RunStore
        yield* store.create("run-span", "{}")
        yield* store.get("run-span")
      }).pipe(Effect.provideService(Tracer.Tracer, tracer))
    )

    const createSpan = spans.find((span) => span.name === "RunStore.create")
    expect(createSpan).toBeDefined()
    expect(createSpan!.attributes.get("runId")).toBe("run-span")
    const getSpan = spans.find((span) => span.name === "RunStore.get")
    expect(getSpan).toBeDefined()
    expect(getSpan!.attributes.get("runId")).toBe("run-span")
  })

  it("closes create, get, and requestCancel spans with an outcome", async () => {
    const spans: Array<Tracer.NativeSpan> = []
    const tracer = Tracer.make({
      span(options) {
        const span = new Tracer.NativeSpan(options)
        spans.push(span)
        return span
      }
    })

    await migrated(
      Effect.gen(function*() {
        const store = yield* RunStore
        yield* store.create("run-exit", "{}")
        yield* store.get("run-exit")
        const cancel = yield* store.requestCancel("run-exit", 7)
        expect(cancel._tag).toBe("CancelRequested")
        yield* Effect.exit(store.get("run-exit-missing"))
      }).pipe(Effect.provideService(Tracer.Tracer, tracer))
    )

    const outcomes = spans
      .filter((span) => span.name.startsWith("RunStore."))
      .map((span) => [span.name, span.attributes.get("outcome")])
    expect(outcomes).toEqual([
      ["RunStore.create", "success"],
      ["RunStore.get", "success"],
      ["RunStore.requestCancel", "cancel_requested"],
      ["RunStore.get", "failure"]
    ])
  })

  it("closes an interrupted operation span with the interrupt outcome", async () => {
    const spans: Array<Tracer.NativeSpan> = []
    const tracer = Tracer.make({
      span(options) {
        const span = new Tracer.NativeSpan(options)
        spans.push(span)
        return span
      }
    })
    // A writer that never completes parks `create` mid-operation, so the
    // interruption below lands while its span is still open.
    const hangingWriter = Layer.succeed(DurableWriter.DurableWriter)(
      DurableWriter.DurableWriter.of({ write: () => Effect.never })
    )

    await Effect.runPromise(
      Effect.gen(function*() {
        const store = yield* RunStore
        const fiber = yield* store.create("run-interrupted", "{}").pipe(
          Effect.forkChild({ startImmediately: true })
        )
        yield* Effect.yieldNow
        yield* Fiber.interrupt(fiber)
      }).pipe(
        Effect.provideService(Tracer.Tracer, tracer),
        Effect.provide(RunStoreLive.layer.pipe(Layer.provide(hangingWriter))),
        Effect.provide(Migrations.layer),
        Effect.provide(TestDatabase.layer),
        Effect.provide(TestClock.layer()),
        Effect.provideService(Metric.MetricRegistry, new Map())
      )
    )

    const created = spans.find((span) => span.name === "RunStore.create")
    expect(created).toBeDefined()
    expect(created!.attributes.get("outcome")).toBe("interrupt")
  })

  it("annotates domain outcomes and failures without replacing the operation exit", async () => {
    const spans: Array<Tracer.NativeSpan> = []
    const tracer = Tracer.make({
      span(options) {
        const span = new Tracer.NativeSpan(options)
        spans.push(span)
        return span
      }
    })
    const owner = { hostId: "span-host", pid: 1, nonce: "span-nonce" }

    const failure = await migrated(
      Effect.gen(function*() {
        const store = yield* RunStore
        yield* store.create("run-outcome", "{}")
        const outcome = yield* store.claimAndOwn(
          "run-outcome",
          { status: "pending", owner: null, heartbeatAtMs: null },
          owner,
          1
        )
        expect(outcome._tag).toBe("Activated")
        return yield* Effect.exit(store.transitionOwned("run-outcome", owner, "completed", "not-json"))
      }).pipe(Effect.provideService(Tracer.Tracer, tracer))
    )

    expect(failure._tag).toBe("Failure")
    expect(spans.find((span) => span.name === "RunStore.claimAndOwn")!.attributes.get("outcome")).toBe("activated")
    expect(spans.find((span) => span.name === "RunStore.transitionOwned")!.attributes.get("outcome")).toBe("failure")
  })
})
