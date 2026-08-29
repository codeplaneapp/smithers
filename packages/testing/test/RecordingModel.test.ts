import { describe, expect, it } from "@effect/vitest"
import { Capability, Permission } from "@smthrs/kernel"
import * as Model from "@smthrs/model/Model"
import { ModelError } from "@smthrs/model/ModelError"
import type * as ModelEvent from "@smthrs/model/ModelEvent"
import * as ModelRequest from "@smthrs/model/ModelRequest"
import { Effect, Fiber, Ref, Stream } from "effect"
import type { RecordedCall } from "../src/Fixture.ts"
import * as RecordingModel from "../src/RecordingModel.ts"

const request = (text: string, modelId = "openai:gpt-5-mini"): ModelRequest.ModelRequest =>
  ModelRequest.ModelRequest.make({
    modelId,
    system: [ModelRequest.SystemPart.make({ text: "You are a concise reviewer." })],
    messages: [ModelRequest.Message.user(text)],
    tools: [],
    params: ModelRequest.GenerationParams.make({ temperature: 0 })
  })

const events: ReadonlyArray<ModelEvent.ModelEvent> = [
  { type: "text-start", id: "text_1" },
  { type: "text-delta", id: "text_1", text: "Small replay change." },
  { type: "text-end", id: "text_1" },
  { type: "settle", stopReason: "stop", responseId: "resp_1" }
]

const collector = Effect.gen(function*() {
  const recorded = yield* Ref.make<ReadonlyArray<RecordedCall>>([])
  return {
    sink: (call: RecordedCall) => Ref.update(recorded, (calls) => [...calls, call]),
    calls: () => Ref.get(recorded)
  }
})

const liveOf = (stream: Stream.Stream<ModelEvent.ModelEvent, Model.ModelFailure>): Model.Model =>
  Model.make({ stream: () => stream })

describe("RecordingModel", () => {
  it.effect("records the request, model, and events of a settled call", () =>
    Effect.gen(function*() {
      const sink = yield* collector
      const recorder = RecordingModel.make(liveOf(Stream.fromIterable(events)), sink.sink)
      const seen = yield* Stream.runCollect(recorder.stream(request("Summarize PR 4821.")))
      expect([...seen]).toEqual(events)
      const calls = yield* sink.calls()
      expect(calls).toHaveLength(1)
      expect(calls[0]!.model).toBe("openai:gpt-5-mini")
      expect(calls[0]!.events).toEqual(events)
      expect(calls[0]!.failure).toBeUndefined()
    }))

  it.effect("records the request as plain data, not the ModelRequest class", () =>
    Effect.gen(function*() {
      const sink = yield* collector
      const recorder = RecordingModel.make(liveOf(Stream.fromIterable(events)), sink.sink)
      yield* Stream.runDrain(recorder.stream(request("Summarize PR 4821.")))
      const [call] = yield* sink.calls()
      expect(call!.request).toEqual({
        modelId: "openai:gpt-5-mini",
        system: [{ type: "text", text: "You are a concise reviewer." }],
        messages: [{ role: "user", content: [{ type: "text", text: "Summarize PR 4821." }] }],
        tools: [],
        params: { temperature: 0 }
      })
      expect(Object.getPrototypeOf(call!.request)).toBe(Object.prototype)
    }))

  it.effect("records the tool-result and retry events the model contract carries", () =>
    Effect.gen(function*() {
      const sink = yield* collector
      const widened: ReadonlyArray<ModelEvent.ModelEvent> = [
        { type: "retry", attempt: 1, code: "transport", delayMillis: 250 },
        { type: "tool-result", id: "call_1", output: "0.42 ETH", isError: false },
        { type: "settle", stopReason: "tool-calls" }
      ]
      const recorder = RecordingModel.make(liveOf(Stream.fromIterable(widened)), sink.sink)
      yield* Stream.runDrain(recorder.stream(request("What is the balance?")))
      const [call] = yield* sink.calls()
      expect(call!.events).toEqual(widened)
    }))

  it.effect("records the events seen and the provider failure that ended them", () =>
    Effect.gen(function*() {
      const sink = yield* collector
      const failure = new ModelError({ code: "rate_limited", message: "429 too many requests", retryAfterMillis: 30 })
      const recorder = RecordingModel.make(
        liveOf(Stream.concat(Stream.fail(failure))(Stream.fromIterable(events.slice(0, 2)))),
        sink.sink
      )
      const error = yield* Stream.runDrain(recorder.stream(request("Summarize PR 4821."))).pipe(Effect.flip)
      expect(error).toBe(failure)
      const [call] = yield* sink.calls()
      expect(call!.events).toEqual(events.slice(0, 2))
      expect(call!.failure).toMatchObject({ code: "rate_limited", message: "429 too many requests" })
    }))

  it.effect("records nothing when the kernel refused the call", () =>
    Effect.gen(function*() {
      const sink = yield* collector
      const denied = Permission.permissionDenied(Capability.make("model:call", "openai:gpt-5-mini"), "no grant")
      const recorder = RecordingModel.make(liveOf(Stream.fail(denied)), sink.sink)
      const error = yield* Stream.runDrain(recorder.stream(request("Summarize PR 4821."))).pipe(Effect.flip)
      expect(error).toBe(denied)
      expect(yield* sink.calls()).toEqual([])
    }))

  it.effect("records nothing when the call is interrupted before it settles", () =>
    Effect.gen(function*() {
      const sink = yield* collector
      const unsettled = Stream.concat(Stream.fromEffect(Effect.never))(Stream.fromIterable(events.slice(0, 1)))
      const recorder = RecordingModel.make(liveOf(unsettled), sink.sink)
      const fiber = yield* Stream.runDrain(recorder.stream(request("Summarize PR 4821."))).pipe(
        Effect.forkChild({ startImmediately: true })
      )
      yield* Effect.yieldNow
      yield* Fiber.interrupt(fiber)
      expect(yield* sink.calls()).toEqual([])
    }))

  it.effect("records one call per stream, so a re-run appends a second", () =>
    Effect.gen(function*() {
      const sink = yield* collector
      const recorder = RecordingModel.make(liveOf(Stream.fromIterable(events)), sink.sink)
      yield* Stream.runDrain(recorder.stream(request("Summarize PR 4821.")))
      yield* Stream.runDrain(recorder.stream(request("Classify PR 4821.")))
      expect(yield* sink.calls()).toHaveLength(2)
    }))

  it.effect("provides the recording model as the Model seam", () =>
    Effect.gen(function*() {
      const sink = yield* collector
      const layer = RecordingModel.layer(liveOf(Stream.fromIterable(events)), sink.sink)
      yield* Effect.gen(function*() {
        const model = yield* Model.Model
        yield* Stream.runDrain(model.stream(request("Summarize PR 4821.")))
      }).pipe(Effect.provide(layer))
      expect(yield* sink.calls()).toHaveLength(1)
    }))
})
