import { describe, expect, it } from "@effect/vitest"
import * as ProductionModelRequest from "@smthrs/model/ModelRequest"
import { Effect, Fiber, Stream } from "effect"
import { decode, type Fixture } from "../src/Fixture.ts"
import type { ModelRequestLike } from "../src/ModelLike.ts"
import { make, scripted } from "../src/RecordedModel.ts"
import journal from "./fixtures/small-run/journal.json" with { type: "json" }

const request = (text: string, modelId = "openai:gpt-5-mini"): ModelRequestLike => ({
  modelId,
  system: [{ type: "text", text: "You are a concise reviewer." }],
  messages: [{ role: "user", content: [{ type: "text", text }] }],
  tools: [],
  params: {}
})

const fixture: Fixture = {
  calls: [
    {
      request: request("Summarize PR 4821."),
      model: "openai:gpt-5-mini",
      events: [
        { type: "text-start", id: "text_1" },
        { type: "text-delta", id: "text_1", text: "Small replay change." },
        { type: "text-end", id: "text_1" },
        { type: "settle", stopReason: "stop", responseId: "resp_1" }
      ]
    },
    {
      request: request("Classify PR 4821."),
      model: "openai:gpt-5-mini",
      events: [{ type: "settle", stopReason: "stop", responseId: "resp_2" }]
    }
  ]
}

describe("RecordedModel", () => {
  it.effect("replays recorded events in order", () =>
    Effect.gen(function*() {
      const replay = yield* make(fixture)
      const events = yield* Stream.runCollect(replay.model.stream(fixture.calls[0]!.request))
      expect([...events]).toEqual(fixture.calls[0]!.events)
    }))

  it.effect("accepts the production ModelRequest class shape", () =>
    Effect.gen(function*() {
      const replay = yield* make(fixture)
      const productionRequest = ProductionModelRequest.ModelRequest.make({
        modelId: "openai:gpt-5-mini",
        system: [ProductionModelRequest.SystemPart.make({ text: "You are a concise reviewer." })],
        messages: [ProductionModelRequest.Message.user("Summarize PR 4821.")],
        tools: [],
        params: ProductionModelRequest.GenerationParams.make()
      })
      const events = yield* Stream.runCollect(replay.model.stream(productionRequest))
      expect([...events]).toEqual(fixture.calls[0]!.events)
    }))

  it.effect("fails loudly for an unscripted request", () =>
    Effect.gen(function*() {
      const replay = yield* make(fixture)
      const error = yield* Stream.runCollect(replay.model.stream(request("An unrecorded prompt."))).pipe(Effect.flip)
      expect("_tag" in error && error._tag).toBe("UnscriptedModelError")
    }))

  it.effect("fails when the fixture model identity differs", () =>
    Effect.gen(function*() {
      const mismatch: Fixture = {
        calls: [{ ...fixture.calls[0]!, model: "anthropic:claude-sonnet-4" }]
      }
      const replay = yield* make(mismatch)
      const error = yield* Stream.runCollect(replay.model.stream(mismatch.calls[0]!.request)).pipe(Effect.flip)
      expect("_tag" in error && error._tag).toBe("ReplayHarnessMismatchError")
    }))

  it.effect("reports untouched fixture calls", () =>
    Effect.gen(function*() {
      const replay = yield* scripted(...fixture.calls)
      yield* Stream.runDrain(replay.model.stream(fixture.calls[0]!.request))
      expect(yield* replay.controller.unconsumed()).toEqual([fixture.calls[1]])
    }))

  it.effect("settles cleanly when a partially consumed replay is interrupted", () =>
    Effect.gen(function*() {
      const replay = yield* make(fixture)
      const fiber = yield* replay.model.stream(fixture.calls[0]!.request).pipe(
        Stream.runForEach(() => Effect.never),
        Effect.forkChild({ startImmediately: true })
      )
      yield* Effect.yieldNow
      yield* Fiber.interrupt(fiber)
      expect(yield* replay.controller.unconsumed()).toEqual([fixture.calls[1]])
    }))

  it.effect("decodes the small checked-in JSON fixture shape", () =>
    Effect.gen(function*() {
      const decoded = yield* decode(journal)
      expect(decoded.calls).toHaveLength(2)
      expect(decoded.calls[0]!.events[1]).toEqual({
        type: "text-delta",
        id: "text_1",
        text: "PR 4821 updates the replay harness."
      })
    }))
})
