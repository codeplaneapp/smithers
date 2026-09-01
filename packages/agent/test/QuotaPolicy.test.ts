/**
 * Quota-aware waits at a model-backed step.
 *
 * A provider that refuses because a window is exhausted is not reporting a
 * defect: it is telling the run when to come back. Today that refusal reaches
 * `AgentAction` as a `HarnessError model_failed` and ends the step. These cases
 * cover the park that should happen instead — the classification, the durable
 * wait under the `quota` reason, the wake, and the retry that costs the step
 * neither a correction nor an attempt of its own — plus the two edges: a wait
 * longer than the composition tolerates, and a composition that classifies
 * nothing.
 *
 * The park is durable, so these run on the production engine over one
 * in-memory SQLite database. Two things keep them honest and fast: the clock
 * is `TestClock`, so a three-second window is three seconds the test states
 * rather than three seconds it waits, and the wake deadline can be asserted
 * exactly instead of approximately; and the park case replays itself through
 * `RecordedModel`, so the scripted provider is checked against a recording of
 * the real requests rather than trusted on its own.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { FlowEngine } from "@smthrs/engine"
import * as DurableEngineState from "@smthrs/engine-store/DurableEngineState"
import * as EngineStore from "@smthrs/engine-store/EngineStore"
import * as StepBoundary from "@smthrs/engine-store/StepBoundary"
import * as TestStores from "@smthrs/engine-store/test/TestStores"
import { Action, Flow, FlowRuntime, Interpreter } from "@smthrs/flow"
import { Journal } from "@smthrs/journal"
import * as Jj from "@smthrs/kernel/Jj"
import * as Model from "@smthrs/model/Model"
import { ModelError } from "@smthrs/model/ModelError"
import * as ModelEvent from "@smthrs/model/ModelEvent"
import type * as Route from "@smthrs/model/Route"
import * as Registry from "@smthrs/registry/Registry"
import type * as Fixture from "@smthrs/testing/Fixture"
import type * as ModelLike from "@smthrs/testing/ModelLike"
import * as RecordedModel from "@smthrs/testing/RecordedModel"
import { Cause, Effect, Exit, Fiber, Layer, Option, Schedule, Schema, Stream } from "effect"
import * as Clock from "effect/Clock"
import type * as Crypto from "effect/Crypto"
import type * as Scope from "effect/Scope"
import { TestClock } from "effect/testing"
import { describe, expect, it } from "vitest"
import * as Agent from "../src/Agent.ts"
import * as AgentAction from "../src/AgentAction.ts"
import * as Budget from "../src/Budget.ts"
import type * as FlowEngineLike from "../src/FlowEngineLike.ts"
import * as QuotaPolicy from "../src/QuotaPolicy.ts"
import * as Seat from "../src/Seat.ts"
import * as SeatResolver from "../src/SeatResolver.ts"

const prepared: Route.PreparedRequest = {
  routeId: "route-a",
  protocolId: "test-protocol",
  method: "POST",
  url: "https://example.invalid/v1/messages",
  publicHeaders: { "content-type": "application/json" },
  body: new TextEncoder().encode("{}"),
  bodyText: "{}"
}

const route: FlowEngineLike.RouteResolver = { prepare: () => Effect.succeed(prepared) }

const answering = (output: string): string => `ctx.done(${JSON.stringify(output)})`

/**
 * A model that refuses its first call with the given error and answers every
 * later one.
 *
 * `calls` counts what actually reached the provider, which is how a replayed
 * step is told from a re-issued one.
 */
const refusingOnce = (error: ModelError, calls: Array<string>): Model.Model =>
  Model.make({
    stream: () =>
      Stream.unwrap(
        Effect.sync(() => {
          calls.push("call")
          if (calls.length === 1) return Stream.fail(error)
          return Stream.fromIterable([
            ModelEvent.ModelEvent.TextStart({ type: "text-start", id: "cell" }),
            ModelEvent.ModelEvent.TextDelta({
              type: "text-delta",
              id: "cell",
              text: "```cell\n" + answering(`{"approved":true,"issues":[]}`) + "\n```"
            }),
            ModelEvent.ModelEvent.TextEnd({ type: "text-end", id: "cell" }),
            ModelEvent.ModelEvent.Settle({ type: "settle", stopReason: "stop" })
          ])
        })
      )
  })

/** One provider call as it really happened, for a fixture to replay. */
interface Captured {
  readonly request: Parameters<Model.Model["stream"]>[0]
  readonly events: Array<ModelEvent.ModelEvent>
}

/**
 * Wraps a model so every request it is given, and every event it answered
 * with, is recorded.
 *
 * A failed call records its request and no events, which is exactly the shape
 * a fixture stores a refusal in.
 */
const capturing = (inner: Model.Model, captured: Array<Captured>): Model.Model =>
  Model.make({
    stream: (request) =>
      Stream.unwrap(Effect.sync(() => {
        const entry: Captured = { request, events: [] }
        captured.push(entry)
        return inner.stream(request).pipe(
          Stream.tap((event) => Effect.sync(() => entry.events.push(event)))
        )
      }))
  })

/**
 * The recorded model as the production port needs it.
 *
 * `RecordedModel` fails with the fixture's structural refusal, and the sealed
 * model step encodes its failure against `/model/ModelError`, which accepts
 * the class alone. Rebuilding it through the classifier's own reader is the
 * whole adapter: it is shape, not behavior, and it only works because the
 * replay stamps the tag the reader matches on.
 */
const fromRecording = (replay: RecordedModel.Replay): Model.Model =>
  Model.make({
    stream: (request) =>
      (replay.model.stream(request) as unknown as Stream.Stream<ModelEvent.ModelEvent, unknown>).pipe(
        Stream.catchCause((cause) =>
          Stream.fail(
            Option.getOrElse(
              QuotaPolicy.modelErrorOf(Cause.squash(cause)),
              () => new ModelError({ code: "unknown", message: String(Cause.squash(cause)) })
            )
          )
        )
      )
  })

/** A model that never answers, so a park can only ever be followed by another. */
const alwaysRefusing = (error: ModelError, calls: Array<string>): Model.Model =>
  Model.make({
    stream: () =>
      Stream.unwrap(
        Effect.sync(() => {
          calls.push("call")
          return Stream.fail(error)
        })
      )
  })

const emptyRegistry: Registry.Registry = Registry.makeNoop({
  list: () => Effect.succeed([]),
  visible: () => Effect.succeed([]),
  getOption: () => Effect.succeed(Option.none())
})

const hostWith = (overrides: Partial<AgentAction.Host> = {}): AgentAction.Host => ({
  registry: emptyRegistry,
  limits: { calls: 8 },
  capabilityEnvelope: [],
  maxFrames: 3,
  // A refusal this suite parks on is never a transport hiccup, so the
  // transport ladder is off and the park is the only thing that waits.
  modelRetryPolicy: Schedule.recurs(0),
  ...overrides
})

const host = hostWith()

const seats = (model: Model.Model): Layer.Layer<SeatResolver.SeatResolver> =>
  SeatResolver.layer({
    resolve: (id) => Effect.succeed(Seat.make({ id, model, route, contextWindowTokens: 200_000 }))
  })

const Review = Schema.Struct({ approved: Schema.Boolean, issues: Schema.Array(Schema.String) })

const Reviewer = AgentAction.make("agent/test/quota/Reviewer", {
  payload: { diff: Schema.String },
  output: Review,
  seat: "anthropic:test-model",
  prompt: ({ diff }) => `Review this diff:\n${diff}`
})

const ReviewFlow = Flow.make("agent/test/quota/ReviewFlow", {
  payload: { diff: Schema.String },
  success: Review,
  error: AgentAction.AgentFailure,
  body: ({ diff }) => Reviewer.call({ diff })
})

const jj = Jj.make({
  snapshot: () => Effect.succeed({ changeId: "quota-snapshot" as never }),
  restore: () => Effect.void,
  diff: () => Effect.succeed(""),
  workspaceAdd: () => Effect.void,
  workspaceForget: () => Effect.void,
  status: () => Effect.succeed("")
})

const stores = Layer.mergeAll(
  Layer.sync(DurableEngineState.DurableEngineState)(DurableEngineState.makeMemory),
  StepBoundary.layerTest(),
  Layer.succeed(Jj.Jj)(jj),
  TestStores.layer()
)

/**
 * Runs one body against fresh durable stores and a TEST clock.
 *
 * The clock is provided outside the stores so everything under it reads the
 * same time: the classifier that chooses a deadline, the engine row that
 * records it, and the durable timer that waits it out.
 */
const durable = <A, E>(body: Effect.Effect<A, E, Crypto.Crypto | Scope.Scope>): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(Effect.provide(body, Layer.merge(NodeCrypto.layer, TestClock.layer()))).pipe(Effect.orDie)
  )

/**
 * Advances the test clock until one forked run settles, then joins it.
 *
 * Bounded, so a run that never wakes fails the case rather than spinning.
 */
const settle = <A, E>(fiber: Fiber.Fiber<A, E>): Effect.Effect<A, E> =>
  Effect.gen(function*() {
    for (let step = 0; step < 60 && fiber.pollUnsafe() === undefined; step++) {
      yield* TestClock.adjust("1 second")
    }
    return yield* Fiber.join(fiber)
  })

/** One engine incarnation and the composition under one declared step. */
const incarnation = (
  hostId: string,
  model: Model.Model,
  classifier: Layer.Layer<QuotaPolicy.QuotaClassifier>,
  composition: AgentAction.Host = host
) =>
  Effect.gen(function*() {
    const engine = yield* EngineStore.make({
      owner: { hostId },
      journalSource: `quota-${hostId}`,
      isAlive: () => Effect.succeed(false)
    })
    return Layer.mergeAll(Reviewer.layer, Interpreter.layer(ReviewFlow)).pipe(
      Layer.provideMerge(AgentAction.layerHost(composition)),
      Layer.provideMerge(seats(model)),
      Layer.provideMerge(Layer.merge(Agent.layer, Agent.layerDefaults)),
      Layer.provideMerge(classifier),
      Layer.provideMerge(Budget.layerUnbounded()),
      Layer.provideMerge(Action.layerImplementations),
      Layer.provideMerge(Layer.succeed(FlowRuntime.FlowRuntime)(engine))
    )
  })

/**
 * The same composition on the reference memory engine.
 *
 * The two edge cases below never park, so they need no durable store — and a
 * failure that reaches a caller in memory is the failure itself rather than the
 * decoded shape a persisted cause comes back as.
 */
const memory = (model: Model.Model, classifier: Layer.Layer<QuotaPolicy.QuotaClassifier>) =>
  Layer.mergeAll(Reviewer.layer, Interpreter.layer(ReviewFlow)).pipe(
    Layer.provideMerge(AgentAction.layerHost(host)),
    Layer.provideMerge(seats(model)),
    Layer.provideMerge(Layer.merge(Agent.layer, Agent.layerDefaults)),
    Layer.provideMerge(classifier),
    Layer.provideMerge(Budget.layerUnbounded()),
    Layer.provideMerge(Action.layerImplementations),
    Layer.provideMerge(FlowEngine.layerMemory),
    Layer.provideMerge(NodeCrypto.layer)
  )

/**
 * The quota waiting rows, once the run has parked.
 *
 * Bounded: it gives up well before the park's own deadline, so a run that
 * never parks fails the assertion instead of hanging the suite.
 */
const waitForPark = (state: DurableEngineState.Service) =>
  Effect.gen(function*() {
    // Yields rather than sleeps: parking costs the run fiber turns, not time,
    // and advancing the clock here would move the deadline the case asserts.
    for (let attempt = 0; attempt < 400; attempt++) {
      const rows = yield* state.waitingRuns({ reason: "quota" })
      if (rows.length > 0) return rows
      yield* Effect.yieldNow
    }
    return yield* state.waitingRuns({ reason: "quota" })
  })

const parks = (entries: ReadonlyArray<{ readonly eventType: string; readonly payload: unknown }>) =>
  entries
    .filter((entry) => entry.eventType === QuotaPolicy.quotaParkedEvent)
    .map((entry) => entry.payload)

const rateLimited = new ModelError({
  code: "rate_limited",
  message: "Too many requests",
  retryAfterMillis: 3_000,
  httpStatus: 429
})

describe("the default classifier", () => {
  const classify = (error: unknown, now: number) => QuotaPolicy.makeDefault().classify(error, now)

  it("prefers the provider's own reset instant", () => {
    const park = classify(
      new ModelError({
        code: "quota_exceeded",
        message: "Monthly quota exhausted",
        resetAtEpochMillis: 5_000,
        retryAfterMillis: 60_000
      }),
      1_000
    )

    expect(Option.getOrUndefined(park)).toEqual({ wakeAt: 5_000, source: "reset" })
  })

  it("falls back to retry-after, and then to the configured default wait", () => {
    expect(Option.getOrUndefined(classify(rateLimited, 1_000))).toEqual({
      wakeAt: 4_000,
      source: "retry-after"
    })
    expect(
      Option.getOrUndefined(
        QuotaPolicy.makeDefault({ defaultWaitMillis: 30_000 }).classify(
          new ModelError({ code: "quota_exceeded", message: "no quota left" }),
          1_000
        )
      )
    ).toEqual({ wakeAt: 31_000, source: "default" })
  })

  it("reads a reset out of the message when the provider sent no field", () => {
    const park = classify(
      new ModelError({ code: "rate_limited", message: "Rate limit reached. Try again in 45 seconds." }),
      1_000
    )

    expect(Option.getOrUndefined(park)).toEqual({ wakeAt: 46_000, source: "text" })
  })

  it("refuses a wait longer than the ceiling, so the failure stays a failure", () => {
    const park = QuotaPolicy.makeDefault({ maxWaitMillis: 10_000 }).classify(
      new ModelError({ code: "quota_exceeded", message: "back tomorrow", retryAfterMillis: 86_400_000 }),
      1_000
    )

    expect(Option.isNone(park)).toBe(true)
  })

  it("classifies nothing that is not a quota refusal", () => {
    expect(
      Option.isNone(classify(new ModelError({ code: "provider_internal", message: "boom" }), 1_000))
    ).toBe(true)
    expect(Option.isNone(classify(new Error("boom"), 1_000))).toBe(true)
  })

  it("finds the model error a harness failure wrapped", () => {
    const wrapped = { _tag: "/harness/HarnessError", code: "model_failed", cause: rateLimited }
    expect(Option.isSome(QuotaPolicy.modelErrorOf(wrapped))).toBe(true)
  })

  it("reads a decoded model error back, fields and all", () => {
    // What a failure looks like after a journal round trip: the fields survive,
    // the prototype does not.
    const decoded = {
      _tag: "flows/model/ModelError",
      code: "rate_limited",
      message: "slow down",
      retryAfterMillis: 5_000,
      resetAtEpochMillis: 9_000,
      httpStatus: 429
    }
    const park = classify({ _tag: "/harness/HarnessError", code: "model_failed", cause: decoded }, 1_000)

    expect(Option.getOrUndefined(park)).toEqual({ wakeAt: 9_000, source: "reset" })
  })

  it("reads a decoded model error that carries only its code", () => {
    const decoded = { _tag: "flows/model/ModelError", code: "quota_exceeded" }
    const park = QuotaPolicy.makeDefault({ defaultWaitMillis: 1_500 }).classify(decoded, 1_000)

    expect(Option.getOrUndefined(park)).toEqual({ wakeAt: 2_500, source: "default" })
  })

  it("classifies a bare 429 whose code the adapter could not read", () => {
    const park = classify(
      new ModelError({ code: "unknown", message: "429", httpStatus: 429, retryAfterMillis: 500 }),
      1_000
    )

    expect(Option.getOrUndefined(park)).toEqual({ wakeAt: 1_500, source: "retry-after" })
  })

  it("parks for nothing when the deadline it was given has already passed", () => {
    const park = classify(
      new ModelError({ code: "rate_limited", message: "window reopened", resetAtEpochMillis: 500 }),
      1_000
    )

    expect(Option.getOrUndefined(park)).toEqual({ wakeAt: 500, source: "reset" })
  })

  it("gives up on a cause chain rather than walking it forever", () => {
    const deep = { _tag: "/harness/HarnessError", code: "model_failed" } as {
      _tag: string
      code: string
      cause?: unknown
    }
    deep.cause = deep

    expect(Option.isNone(QuotaPolicy.modelErrorOf(deep))).toBe(true)
    expect(Option.isNone(QuotaPolicy.modelErrorOf(undefined))).toBe(true)
  })

  it("reads a minute-scale and an hour-scale delay out of prose", () => {
    expect(QuotaPolicy.parseDelay("Rate limit reached. Try again in 2 minutes.")).toBe(120_000)
    expect(QuotaPolicy.parseDelay("quota resets in 1 hour")).toBe(3_600_000)
    expect(QuotaPolicy.parseDelay("retry-after: 30")).toBe(30_000)
    expect(QuotaPolicy.parseDelay("Rate limited. Retry after 5 minutes.")).toBe(300_000)
    expect(QuotaPolicy.parseDelay("retry after 2 hours")).toBe(7_200_000)
    expect(QuotaPolicy.parseDelay("Retry-After: 120")).toBe(120_000)
    expect(QuotaPolicy.parseDelay("retry after 90 seconds")).toBe(90_000)
    // Unit-specific prose wins over the bare header form, even when the bare
    // header appears first, because it carries the less ambiguous duration.
    expect(QuotaPolicy.parseDelay("Retry-After: 120. Retry after 5 minutes.")).toBe(300_000)
    expect(QuotaPolicy.parseDelay("try again in about a minute")).toBeUndefined()
    expect(QuotaPolicy.parseDelay("try again in -3 seconds")).toBeUndefined()
  })

  it("reads the classifier a composition explicitly provides", async () => {
    const provided = await Effect.runPromise(
      QuotaPolicy.current.pipe(Effect.provide(QuotaPolicy.layerDefault()))
    )
    expect(Option.isSome(provided.classify(rateLimited, 1_000))).toBe(true)
  })
})

describe("a quota refusal at a model-backed step", () => {
  it("parks the run under the quota reason, wakes on the deadline, and answers", async () => {
    const calls: Array<string> = []
    const captured: Array<Captured> = []
    const observed = await durable(
      Effect.gen(function*() {
        const state = yield* DurableEngineState.DurableEngineState
        const wiring = yield* incarnation(
          "parking",
          capturing(refusingOnce(rateLimited, calls), captured),
          QuotaPolicy.layerDefault()
        )
        const startedAt = yield* Clock.currentTimeMillis
        const running = yield* ReviewFlow.execute({ diff: "-  old\n+  new" }, {
          executionId: "quota-park"
        }).pipe(Effect.provide(wiring), Effect.forkChild({ startImmediately: true }))
        // Parking costs fiber turns, not time, so the waiting row appears
        // without the clock moving and the deadline below is exact.
        const waiting = yield* waitForPark(state)
        const value = yield* settle(running)
        const journal = yield* Journal.Journal
        yield* journal.flush
        const page = yield* journal.entries({ runId: "quota-park" as never, limit: 200 })
        return { value, waiting, startedAt, records: parks(page.entries) }
      }).pipe(Effect.provide(stores))
    )

    expect(observed.value).toEqual({ approved: true, issues: [] })
    expect(observed.waiting.map((row) => row.runId)).toEqual(["quota-park"])
    expect(observed.waiting[0]?.reason).toBe("quota")
    // The deadline is exactly what the provider asked for, measured from the
    // instant the refusal was classified.
    expect(observed.waiting[0]?.wakeAt).toBe(observed.startedAt + 3_000)
    // And it is the one the recorded decision chose, not a second instant
    // computed while parking.
    expect(observed.waiting[0]?.wakeAt).toBe(
      (observed.records[0] as { readonly wakeAt: number }).wakeAt
    )
    // The provider was asked twice: the refusal, then the answer after the
    // wake. Nothing about the step's own budget was spent on the refusal.
    expect(calls).toHaveLength(2)
    expect(observed.records).toHaveLength(1)
    expect(observed.records[0]).toMatchObject({
      action: "agent/test/quota/Reviewer",
      source: "retry-after"
    })
  })

  it("parks and wakes the same way when the provider is a recording of that run", async () => {
    // Pass one records the real requests and events; pass two drives the same
    // run from that recording, so the park is exercised against fixture data
    // rather than against a model written to make the case pass.
    const captured: Array<Captured> = []
    const calls: Array<string> = []
    await durable(
      Effect.gen(function*() {
        const state = yield* DurableEngineState.DurableEngineState
        const wiring = yield* incarnation(
          "record",
          capturing(refusingOnce(rateLimited, calls), captured),
          QuotaPolicy.layerDefault()
        )
        const running = yield* ReviewFlow.execute({ diff: "-  old\n+  new" }, {
          executionId: "quota-record"
        }).pipe(Effect.provide(wiring), Effect.forkChild({ startImmediately: true }))
        yield* waitForPark(state)
        return yield* settle(running)
      }).pipe(Effect.provide(stores))
    )
    // The refusal is call zero, which is what `refusingOnce` means, so the
    // fixture says so rather than inferring it from an empty event list.
    const fixture: Fixture.Fixture = {
      calls: captured.map((call, index) => ({
        request: call.request as unknown as ModelLike.ModelRequestLike,
        model: call.request.modelId,
        events: call.events as unknown as ReadonlyArray<ModelLike.ModelEventLike>,
        ...(index === 0
          ? {
            failure: {
              code: "rate_limited" as const,
              message: rateLimited.message,
              retryAfterMillis: 3_000,
              httpStatus: 429
            }
          }
          : {})
      }))
    }

    const replayed = await durable(
      Effect.gen(function*() {
        const state = yield* DurableEngineState.DurableEngineState
        const replay = yield* RecordedModel.make(fixture)
        const wiring = yield* incarnation("replay", fromRecording(replay), QuotaPolicy.layerDefault())
        const startedAt = yield* Clock.currentTimeMillis
        const running = yield* ReviewFlow.execute({ diff: "-  old\n+  new" }, {
          executionId: "quota-replay"
        }).pipe(Effect.provide(wiring), Effect.forkChild({ startImmediately: true }))
        const waiting = yield* waitForPark(state)
        const value = yield* settle(running)
        return { value, waiting, startedAt, unconsumed: yield* replay.controller.unconsumed() }
      }).pipe(Effect.provide(stores))
    )

    expect(captured).toHaveLength(2)
    expect(replayed.value).toEqual({ approved: true, issues: [] })
    expect(replayed.waiting[0]?.reason).toBe("quota")
    // The deadline the REPLAY parked on is the one the recording's own refusal
    // asked for, measured from the instant the replayed pass started: the
    // fixture carries `retryAfterMillis` 3,000, so a park driven by recorded
    // data lands on exactly the same instant a park driven by the live
    // provider did. Without this the case would pass on a park at any deadline
    // at all.
    expect(replayed.waiting[0]?.wakeAt).toBe(replayed.startedAt + 3_000)
    // The recording drove the second pass alone: the scripted provider was
    // asked twice in pass one and never again.
    expect(calls).toHaveLength(2)
    // Every recorded call was matched and consumed: the recording drove the
    // whole park, and the refusal replayed AS a refusal rather than as a bare
    // structural object the classifier would have ignored.
    expect(replayed.unconsumed).toEqual([])
  })

  it("resumes a parked run on a second engine without re-issuing the refusal", async () => {
    const calls: Array<string> = []
    // One database, one execution id, two engines. The first parks on the
    // provider's refusal and is then CLOSED while the run is still waiting;
    // the second is built over the same database and has to finish the run
    // from what the first one wrote down.
    const observed = await durable(
      Effect.gen(function*() {
        const state = yield* DurableEngineState.DurableEngineState
        const waiting = yield* Effect.scoped(
          Effect.gen(function*() {
            const wiring = yield* incarnation(
              "park-before",
              refusingOnce(rateLimited, calls),
              QuotaPolicy.layerDefault()
            )
            const running = yield* ReviewFlow.execute({ diff: "-  old\n+  new" }, {
              executionId: "quota-boundary"
            }).pipe(Effect.provide(wiring), Effect.forkChild({ startImmediately: true }))
            const rows = yield* waitForPark(state)
            // The kill is explicit: the fiber holding the parked run is gone
            // before the engine scope closes, so nothing from the first
            // incarnation can finish the run behind the second one's back.
            yield* Fiber.interrupt(running)
            return rows
          })
        )
        const parkedCalls = calls.length
        const value = yield* Effect.scoped(
          Effect.gen(function*() {
            const wiring = yield* incarnation(
              "park-after",
              refusingOnce(rateLimited, calls),
              QuotaPolicy.layerDefault()
            )
            // Forked, because the resumed run waits out the deadline the first
            // engine recorded and only the test can advance the clock past it.
            const resuming = yield* ReviewFlow.execute({ diff: "-  old\n+  new" }, {
              executionId: "quota-boundary"
            }).pipe(Effect.provide(wiring), Effect.forkChild({ startImmediately: true }))
            return yield* settle(resuming)
          })
        )
        const journal = yield* Journal.Journal
        yield* journal.flush
        const page = yield* journal.entries({ runId: "quota-boundary" as never, limit: 500 })
        return { waiting, parkedCalls, value, records: parks(page.entries) }
      }).pipe(Effect.provide(stores))
    )

    // The first engine parked and wrote the deadline down.
    expect(observed.waiting.map((row) => row.runId)).toEqual(["quota-boundary"])
    expect(observed.waiting[0]?.reason).toBe("quota")
    expect(observed.parkedCalls).toBe(1)
    // The second engine finished the run.
    expect(observed.value).toEqual({ approved: true, issues: [] })
    // Two provider calls in all: the refusal before the boundary and the
    // answer after it. The refusal was never re-issued.
    expect(calls).toHaveLength(2)
    // ONE park decision across both engines. The decision is a recorded step,
    // so the second engine replayed the deadline the first one chose instead
    // of classifying afresh and pushing the wake further out.
    expect(observed.records).toHaveLength(1)
    expect(observed.waiting[0]?.wakeAt).toBe(
      (observed.records[0] as { readonly wakeAt: number }).wakeAt
    )
  })

  it("propagates the provider's failure when the wait is longer than the ceiling", async () => {
    const calls: Array<string> = []
    const exit = await Effect.runPromise(
      Effect.exit(
        ReviewFlow.execute({ diff: "-  old\n+  new" }, { executionId: "quota-ceiling" }).pipe(
          Effect.provide(
            memory(
              refusingOnce(
                new ModelError({
                  code: "quota_exceeded",
                  message: "monthly quota exhausted",
                  retryAfterMillis: 86_400_000
                }),
                calls
              ),
              QuotaPolicy.layerDefault({ maxWaitMillis: 10_000 })
            )
          )
        )
      )
    )

    expect(Exit.isFailure(exit)).toBe(true)
    const refused = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined
    // The refusal reaches the caller as the step's own failure rather than a
    // park. What identifies it is the provider's message: `HarnessError.cause`
    // is a `Schema.Defect`, and that codec re-reads any encoded object carrying
    // a `message` as a bare `Error`, so a decoded cause keeps what the provider
    // said and not the `code` field it said it under.
    expect(JSON.stringify(refused)).toContain("model_failed")
    expect(String((refused as { readonly cause?: unknown }).cause)).toContain("monthly quota exhausted")
    // A day is not a wait this composition takes, so the step never asked again.
    expect(calls).toHaveLength(1)
  }, 60_000)

  it("fails as it does today when the composition classifies nothing", async () => {
    const calls: Array<string> = []
    const exit = await Effect.runPromise(
      Effect.exit(
        ReviewFlow.execute({ diff: "-  old\n+  new" }, { executionId: "quota-noop" }).pipe(
          Effect.provide(memory(refusingOnce(rateLimited, calls), QuotaPolicy.layerUnclassified()))
        )
      )
    )

    expect(Exit.isFailure(exit)).toBe(true)
    const refused = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined
    expect(JSON.stringify(refused)).toContain("model_failed")
    expect(String((refused as { readonly cause?: unknown }).cause)).toContain("Too many requests")
    expect(calls).toHaveLength(1)
  }, 60_000)
  it("reports the refusal once the step has spent its park allowance", async () => {
    const calls: Array<string> = []
    const exit = await durable(
      Effect.gen(function*() {
        const wiring = yield* incarnation(
          "bounded",
          alwaysRefusing(
            new ModelError({ code: "rate_limited", message: "still limited", retryAfterMillis: 200 }),
            calls
          ),
          QuotaPolicy.layerDefault(),
          hostWith({ maxQuotaParks: 1 })
        )
        const running = yield* Effect.exit(
          ReviewFlow.execute({ diff: "-  old\n+  new" }, { executionId: "quota-bounded" }).pipe(
            Effect.provide(wiring)
          )
        ).pipe(Effect.forkChild({ startImmediately: true }))
        return yield* settle(running)
      }).pipe(Effect.provide(stores))
    )

    expect(Exit.isFailure(exit)).toBe(true)
    // One allowance, so: the refusal, one park, the ask again, and then the
    // report. A window that is still closed after its own deadline is not one
    // this run waits out forever.
    expect(calls).toHaveLength(2)
  })
})
