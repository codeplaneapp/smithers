/**
 * The recorder is the half `@smthrs/testing` does not ship, so the only thing
 * that proves it works is a full round trip: record a live stream, decode the
 * result with the `Fixture` schema, replay it, and get the same events back.
 * If any of those three steps drifts, a `pnpm test:record` produces a fixture
 * that `pnpm test` cannot read.
 */
import { describe, expect, it } from "@effect/vitest"
import * as Model from "@smthrs/model/Model"
import { ModelError } from "@smthrs/model/ModelError"
import * as ModelEvent from "@smthrs/model/ModelEvent"
import * as ModelRequest from "@smthrs/model/ModelRequest"
import { Fixture, type RecordedCall } from "@smthrs/testing/Fixture"
import * as RecordedModel from "@smthrs/testing/RecordedModel"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import { recordModel } from "../src/testing.ts"

const request = (text: string): ModelRequest.ModelRequest =>
  ModelRequest.ModelRequest.make({
    modelId: "anthropic:claude-sonnet-4-5",
    system: [{ type: "text", text: "You are the app's agent." }],
    messages: [{ role: "user", content: [{ type: "text", text }] }],
    tools: [],
    params: {}
  })

const answer: ReadonlyArray<ModelEvent.ModelEvent> = [
  ModelEvent.ModelEvent.TextStart({ type: "text-start", id: "cell" }),
  ModelEvent.ModelEvent.TextDelta({ type: "text-delta", id: "cell", text: "```cell\nreturn 1\n```" }),
  ModelEvent.ModelEvent.TextEnd({ type: "text-end", id: "cell" }),
  ModelEvent.ModelEvent.Usage({ inputTokens: 12, outputTokens: 4 }),
  ModelEvent.ModelEvent.Settle({ type: "settle", stopReason: "stop" })
]

const live = (events: ReadonlyArray<ModelEvent.ModelEvent> = answer): Model.Model =>
  Model.make({ stream: () => Stream.fromIterable(events) })

const drain = (model: Model.Model, value: ModelRequest.ModelRequest): Promise<Array<ModelEvent.ModelEvent>> =>
  Effect.runPromise(Stream.runCollect(model.stream(value)).pipe(Effect.orDie))

describe("recordModel", () => {
  it("passes the live events through untouched", async () => {
    const calls: Array<RecordedCall> = []
    const events = await drain(recordModel(live(), (call) => calls.push(call)), request("hi"))
    expect(events).toEqual(answer)
  })

  it("records one call per request, with the model id and the request", async () => {
    const calls: Array<RecordedCall> = []
    const recorder = recordModel(live(), (call) => calls.push(call))
    await drain(recorder, request("first"))
    await drain(recorder, request("second"))

    expect(calls).toHaveLength(2)
    expect(calls[0]!.model).toBe("anthropic:claude-sonnet-4-5")
    expect(calls[0]!.request.messages[0]).toEqual({ role: "user", content: [{ type: "text", text: "first" }] })
    expect(calls[1]!.request.messages[0]).toEqual({ role: "user", content: [{ type: "text", text: "second" }] })
    expect(calls[0]!.events).toHaveLength(answer.length)
  })

  it("fires the sink after the stream ends, not before", async () => {
    const order: Array<string> = []
    const recorder = recordModel(live(), () => order.push("sink"))
    await Effect.runPromise(
      recorder.stream(request("hi")).pipe(
        Stream.tap(() => Effect.sync(() => order.push("event"))),
        Stream.runDrain,
        Effect.orDie
      )
    )
    expect(order).toEqual(["event", "event", "event", "event", "event", "sink"])
  })

  it("records what it saw when the live stream fails", async () => {
    const calls: Array<RecordedCall> = []
    const failing = Model.make({
      stream: () =>
        Stream.concat(
          Stream.fromIterable(answer.slice(0, 2)),
          Stream.fail(new ModelError({ code: "rate_limited", message: "slow down" }))
        )
    })
    const exit = await Effect.runPromiseExit(
      Stream.runDrain(recordModel(failing, (call) => calls.push(call)).stream(request("hi")))
    )
    expect(exit._tag).toBe("Failure")
    expect(calls).toHaveLength(1)
    expect(calls[0]!.events).toHaveLength(2)
  })

  it("keeps the retry and tool-result events the fixture schema holds", async () => {
    const calls: Array<RecordedCall> = []
    const extra = [
      ModelEvent.ModelEvent.Retry({ type: "retry", attempt: 1, code: "rate_limited", delayMillis: 10 }),
      ModelEvent.ModelEvent.ToolResult({ type: "tool-result", id: "t1", output: "1 ETH" })
    ]
    const withExtra = Model.make({ stream: () => Stream.fromIterable([...extra, ...answer]) })
    await drain(recordModel(withExtra, (call) => calls.push(call)), request("hi"))

    expect(calls[0]!.events).toHaveLength(extra.length + answer.length)
    expect(calls[0]!.events.map((event) => event.type).slice(0, 2)).toEqual(["retry", "tool-result"])
    // The fixture decoder is the reason to keep them: a recording it cannot
    // read is the failure this whole file exists to catch.
    const decoded = await Effect.runPromise(
      Schema.decodeUnknownEffect(Fixture)(JSON.parse(JSON.stringify({ calls })))
    )
    expect(decoded.calls[0]!.events.map((event) => event.type).slice(0, 2)).toEqual(["retry", "tool-result"])
  })

  it("projects an assistant turn and a tool result onto the fixture shape", async () => {
    const calls: Array<RecordedCall> = []
    const conversation = ModelRequest.ModelRequest.make({
      modelId: "anthropic:claude-sonnet-4-5",
      system: [],
      messages: [
        { role: "user", content: [{ type: "text", text: "balance?" }] },
        {
          role: "assistant",
          content: [
            { type: "text", text: "checking" },
            { type: "thinking", text: "call the tool", signature: "sig" },
            { type: "tool-call", id: "t1", name: "balance", arguments: "{}" }
          ],
          stopReason: "tool-calls"
        },
        { role: "tool", content: [{ type: "tool-result", toolCallId: "t1", content: "1 ETH", addedToolNames: [] }] }
      ],
      tools: [],
      params: { maxTokens: 64 }
    })
    await drain(recordModel(live(), (call) => calls.push(call)), conversation)

    const [user, assistant, tool] = calls[0]!.request.messages
    expect(user).toEqual({ role: "user", content: [{ type: "text", text: "balance?" }] })
    expect(assistant?.content.map((part) => part.type)).toEqual(["text", "thinking", "tool-call"])
    expect(tool).toEqual({
      role: "tool",
      content: [{ type: "tool-result", toolCallId: "t1", content: "1 ETH", addedToolNames: [] }]
    })
    expect(calls[0]!.request.params.maxTokens).toBe(64)
  })

  it("projects the declared tools onto the fixture shape", async () => {
    const calls: Array<RecordedCall> = []
    const withTools = ModelRequest.ModelRequest.make({
      modelId: "anthropic:claude-sonnet-4-5",
      system: [],
      messages: [{ role: "user", content: [{ type: "text", text: "balance?" }] }],
      tools: [{
        name: "balance",
        description: "Reads an account balance.",
        parameters: { type: "object", properties: {} },
        deferred: false
      }],
      params: {}
    })
    await drain(recordModel(live(), (call) => calls.push(call)), withTools)
    expect(calls[0]!.request.tools).toEqual([{
      name: "balance",
      description: "Reads an account balance.",
      parameters: { type: "object", properties: {} },
      deferred: false,
      loader: undefined
    }])
  })

  it("decodes a recording as a Fixture and replays it byte-identically", async () => {
    const calls: Array<RecordedCall> = []
    await drain(recordModel(live(), (call) => calls.push(call)), request("hi"))

    // The fixture goes to disk as JSON, so it must survive a stringify/parse.
    const onDisk: unknown = JSON.parse(JSON.stringify({ calls }))
    const fixture = Schema.decodeUnknownSync(Fixture)(onDisk)
    expect(fixture.calls).toHaveLength(1)

    const replay = await Effect.runPromise(RecordedModel.make(fixture))
    const replayed = await Effect.runPromise(
      Stream.runCollect(replay.model.stream(calls[0]!.request)).pipe(Effect.orDie)
    )
    expect(replayed).toEqual(calls[0]!.events)
    expect(await Effect.runPromise(replay.controller.unconsumed())).toEqual([])
  })

  it("fails a replay of an unrecorded request instead of inventing one", async () => {
    const calls: Array<RecordedCall> = []
    await drain(recordModel(live(), (call) => calls.push(call)), request("recorded"))
    const replay = await Effect.runPromise(RecordedModel.make({ calls }))
    const exit = await Effect.runPromiseExit(Stream.runDrain(replay.model.stream(request("never recorded"))))
    expect(exit._tag).toBe("Failure")
  })
})
