import { Effect, Schema } from "effect"
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import * as AnthropicMessages from "../src/AnthropicMessages.ts"
import * as CanonicalJson from "../src/CanonicalJson.ts"
import { ModelError } from "../src/ModelError.ts"
import { ModelEvent } from "../src/ModelEvent.ts"
import {
  GenerationParams,
  Message,
  ModelRequest,
  SystemPart,
  ThinkingPart,
  ToolCallPart,
  ToolDefinition,
  ToolResultPart
} from "../src/ModelRequest.ts"

const fixture = (name: string): string =>
  readFileSync(new URL(`fixtures/anthropic/${name}.sse`, import.meta.url), "utf8")

const frames = (source: string): ReadonlyArray<{ readonly event?: string; readonly data: string }> =>
  source
    .trim()
    .split(/\r?\n\r?\n/)
    .map((record) => {
      const event = record
        .split(/\r?\n/)
        .find((line) => line.startsWith("event:"))
        ?.slice("event:".length)
        .trim()
      const data = record
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice("data:".length).trimStart())
        .join("\n")
      return {
        ...(event === undefined ? {} : { event }),
        data
      }
    })

const streamRequest = ModelRequest.make({
  modelId: "claude-sonnet-4-5",
  system: [],
  messages: [],
  tools: [],
  params: GenerationParams.make()
})

const step = (
  state: ReturnType<typeof AnthropicMessages.protocol.stream.initial>,
  data: string
) => {
  const event = Schema.decodeUnknownSync(AnthropicMessages.protocol.stream.event)(data)
  return Effect.runSync(AnthropicMessages.protocol.stream.step(state, event))
}

const body = (request: ModelRequest, native = true): AnthropicMessages.Body =>
  Effect.runSync(AnthropicMessages.protocol.body.from(request, { native }))

const replay = (data: ReadonlyArray<string>, finalize = false): ReadonlyArray<ModelEvent> => {
  let state = AnthropicMessages.protocol.stream.initial(streamRequest)
  const events: Array<ModelEvent> = []
  for (const datum of data) {
    const [next, emitted] = step(state, datum)
    state = next
    events.push(...emitted)
  }
  if (finalize) events.push(...(AnthropicMessages.protocol.stream.onHalt?.(state) ?? []))
  return events
}

const replayError = (data: ReadonlyArray<string>): ModelError => {
  let state = AnthropicMessages.protocol.stream.initial(streamRequest)
  for (const datum of data.slice(0, -1)) {
    const [next] = step(state, datum)
    state = next
  }
  const last = data[data.length - 1] ?? ""
  const event = Schema.decodeUnknownSync(AnthropicMessages.protocol.stream.event)(last)
  return Effect.runSync(AnthropicMessages.protocol.stream.step(state, event).pipe(Effect.flip))
}

const run = (name: string, finalize = false) => {
  let state = AnthropicMessages.protocol.stream.initial(streamRequest)
  const events: Array<ModelEvent> = []
  for (const frame of frames(fixture(name))) {
    const [next, emitted] = step(state, frame.data)
    state = next
    events.push(...emitted)
  }
  if (finalize) events.push(...(AnthropicMessages.protocol.stream.onHalt?.(state) ?? []))
  return events
}

const tool = (
  name: string,
  input: {
    readonly deferred?: boolean
    readonly loader?: boolean
    readonly reverseProperties?: boolean
  } = {}
): ToolDefinition =>
  ToolDefinition.make({
    name,
    description: `${name} description`,
    parameters: {
      type: "object",
      properties: input.reverseProperties
        ? { days: { type: "number" }, city: { type: "string" } }
        : { city: { type: "string" }, days: { type: "number" } }
    },
    deferred: input.deferred,
    loader: input.loader
  })

const activatedRequest = (
  modelId: string,
  input: { readonly reverseRequest?: boolean; readonly reverseProperties?: boolean } = {}
): ModelRequest => {
  const reverse = input.reverseProperties
  const loader = tool("search_tools", {
    loader: true,
    ...(reverse !== undefined ? { reverseProperties: reverse } : {})
  })
  const weather = tool("weather", { deferred: true, ...(reverse !== undefined ? { reverseProperties: reverse } : {}) })
  const call = ToolCallPart.make({ id: "toolu_loader", name: "search_tools", arguments: "{\"query\":\"weather\"}" })
  const result = ToolResultPart.make({
    toolCallId: "toolu_loader",
    content: "Found weather",
    addedToolNames: ["weather"]
  })
  const values = input.reverseRequest
    ? {
      params: GenerationParams.make({ maxTokens: 512, temperature: 0.2 }),
      tools: [loader, weather],
      messages: [
        Message.assistant(call, { stopReason: "tool-calls" }),
        Message.tool(result)
      ],
      system: [SystemPart.make({ text: "Be concise." })],
      modelId
    }
    : {
      modelId,
      system: [SystemPart.make({ text: "Be concise." })],
      messages: [
        Message.assistant(call, { stopReason: "tool-calls" }),
        Message.tool(result)
      ],
      tools: [loader, weather],
      params: GenerationParams.make({ maxTokens: 512, temperature: 0.2 })
    }
  return ModelRequest.make(values)
}

describe("AnthropicMessages streaming", () => {
  it("parses text and settles exactly once", () => {
    const events = run("text")
    expect(events).toEqual([
      { type: "text-start", id: "text-0" },
      { type: "text-delta", id: "text-0", text: "Hello" },
      { type: "text-delta", id: "text-0", text: ", world" },
      { type: "text-end", id: "text-0" },
      { type: "usage", inputTokens: 12, outputTokens: 3, totalTokens: 15 },
      { type: "settle", stopReason: "stop", responseId: "msg_text" }
    ])
    expect(events.filter((event) => event.type === "settle")).toHaveLength(1)
    expect(ModelEvent.settledMessage(events).message).toMatchObject({
      stopReason: "stop",
      content: [{ type: "text", text: "Hello, world" }]
    })
  })

  it("accumulates fragmented tool arguments", () => {
    const events = run("tool-call")
    expect(events).toEqual([
      { type: "tool-call-start", id: "toolu_01", name: "weather" },
      { type: "tool-call-delta", id: "toolu_01", arguments: "{\"city\":" },
      { type: "tool-call-delta", id: "toolu_01", arguments: "\"Paris\"}" },
      { type: "tool-call-end", id: "toolu_01", arguments: "{\"city\":\"Paris\"}" },
      { type: "usage", inputTokens: 18, outputTokens: 9, totalTokens: 27 },
      { type: "settle", stopReason: "tool-calls", responseId: "msg_tool" }
    ])
    expect(ModelEvent.settledMessage(events).message.content).toEqual([
      {
        type: "tool-call",
        id: "toolu_01",
        name: "weather",
        arguments: "{\"city\":\"Paris\"}"
      }
    ])
  })

  it("attaches a late signature to the complete thinking block", () => {
    const data = [
      "{\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"thinking\",\"thinking\":\"\"}}",
      "{\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"thinking_delta\",\"thinking\":\"Inspect\"}}",
      "{\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"signature_delta\",\"signature\":\"sig_01\"}}",
      "{\"type\":\"content_block_stop\",\"index\":0}",
      "{\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"}}",
      "{\"type\":\"message_stop\"}"
    ]
    let state = AnthropicMessages.protocol.stream.initial(streamRequest)
    const events: Array<ModelEvent> = []
    for (const datum of data) {
      const [next, emitted] = step(state, datum)
      state = next
      events.push(...emitted)
    }
    expect(events).toEqual([
      { type: "thinking-start", id: "thinking-0", signature: "sig_01" },
      { type: "thinking-delta", id: "thinking-0", text: "Inspect" },
      { type: "thinking-end", id: "thinking-0" },
      { type: "settle", stopReason: "stop" }
    ])
    expect(ModelEvent.settledMessage(events).message.content).toEqual([
      { type: "thinking", text: "Inspect", signature: "sig_01" }
    ])
  })

  it("merges Anthropic's cache-aware usage reports", () => {
    const events = run("usage")
    expect(events).toEqual([
      {
        type: "usage",
        inputTokens: 34,
        outputTokens: 4,
        cachedInputTokens: 8,
        cacheWriteTokens: 5,
        totalTokens: 38
      },
      { type: "settle", stopReason: "stop", responseId: "msg_usage" }
    ])
    expect(ModelEvent.settledMessage(events).usage).toEqual({
      inputTokens: 34,
      outputTokens: 4,
      reasoningTokens: undefined,
      cachedInputTokens: 8,
      cacheWriteTokens: 5,
      totalTokens: 38
    })
  })

  it("flushes an open tool call without settling an interrupted stream", () => {
    const events = run("abort-mid-stream", true)
    expect(events).toEqual([
      { type: "tool-call-start", id: "toolu_abort", name: "lookup" },
      { type: "tool-call-delta", id: "toolu_abort", arguments: "{\"query\":\"par" },
      { type: "tool-call-end", id: "toolu_abort", arguments: "{}" }
    ])
    expect(events.some((event) => event.type === "settle")).toBe(false)
    expect(ModelEvent.settledMessage(events).message).toMatchObject({
      stopReason: "aborted",
      content: [
        {
          type: "tool-call",
          id: "toolu_abort",
          name: "lookup",
          arguments: "{}"
        }
      ]
    })

    const followUp = ModelRequest.make({
      modelId: "claude-sonnet-4-5",
      system: [],
      messages: [ModelEvent.settledMessage(events).message, Message.user("continue")],
      tools: [],
      params: GenerationParams.make()
    })
    const requestBody = body(followUp)
    expect(CanonicalJson.stringify(requestBody)).not.toContain("toolu_abort")
    expect(CanonicalJson.stringify(requestBody)).not.toContain("{\\\"query\\\":")
  })

  it("emits the seed text of a content block and skips an empty one", () => {
    expect(replay([
      "{\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"seed\"}}",
      "{\"type\":\"content_block_start\",\"index\":1,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}",
      "{\"type\":\"content_block_start\",\"index\":2,\"content_block\":{\"type\":\"text\"}}"
    ])).toEqual([
      { type: "text-start", id: "text-0" },
      { type: "text-delta", id: "text-0", text: "seed" },
      { type: "text-start", id: "text-1" },
      { type: "text-start", id: "text-2" }
    ])
  })

  it("opens a signed thinking block immediately and a second signature keeps it open", () => {
    expect(replay([
      "{\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"thinking\",\"thinking\":\"pre\",\"signature\":\"sig_0\"}}",
      "{\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"signature_delta\",\"signature\":\"sig_1\"}}",
      "{\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"thinking_delta\",\"thinking\":\" after\"}}",
      "{\"type\":\"content_block_stop\",\"index\":0}"
    ])).toEqual([
      { type: "thinking-start", id: "thinking-0", signature: "sig_0" },
      { type: "thinking-delta", id: "thinking-0", text: "pre" },
      { type: "thinking-delta", id: "thinking-0", text: " after" },
      { type: "thinking-end", id: "thinking-0" }
    ])

    expect(replay([
      "{\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"thinking\",\"thinking\":\"\",\"signature\":\"sig\"}}"
    ])).toEqual([{ type: "thinking-start", id: "thinking-0", signature: "sig" }])
  })

  it("replays a never-signed thinking block in order when its block stops", () => {
    expect(replay([
      "{\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"thinking\",\"thinking\":\"first\"}}",
      "{\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"thinking_delta\",\"thinking\":\" second\"}}",
      "{\"type\":\"content_block_stop\",\"index\":0}"
    ])).toEqual([
      { type: "thinking-start", id: "thinking-0", signature: undefined },
      { type: "thinking-delta", id: "thinking-0", text: "first" },
      { type: "thinking-delta", id: "thinking-0", text: " second" },
      { type: "thinking-end", id: "thinking-0" }
    ])
  })

  it("names a tool block by its index when the provider omits the id and name", () => {
    expect(replay([
      "{\"type\":\"content_block_start\",\"index\":3,\"content_block\":{\"type\":\"tool_use\"}}"
    ])).toEqual([{ type: "tool-call-start", id: "3", name: "" }])
  })

  it("ignores frames that carry no addressable block", () => {
    expect(replay([
      "{\"type\":\"content_block_start\",\"content_block\":{\"type\":\"text\"}}",
      "{\"type\":\"content_block_start\",\"index\":0}",
      "{\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"server_tool_use\",\"id\":\"srv\"}}",
      "{\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"x\"}}",
      "{\"type\":\"content_block_delta\",\"index\":0}",
      "{\"type\":\"content_block_delta\",\"index\":9,\"delta\":{\"type\":\"text_delta\",\"text\":\"x\"}}",
      "{\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"{}\"}}",
      "{\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"citations_delta\"}}",
      "{\"type\":\"content_block_stop\"}",
      "{\"type\":\"content_block_stop\",\"index\":7}",
      "{\"type\":\"ping\"}"
    ])).toEqual([])
  })

  it("fails the stream when a completed tool call did not accumulate JSON", () => {
    const error = replayError([
      "{\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"tool_use\",\"id\":\"toolu_bad\",\"name\":\"weather\"}}",
      "{\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"{oops\"}}",
      "{\"type\":\"content_block_stop\",\"index\":0}"
    ])

    expect(error).toBeInstanceOf(ModelError)
    expect(error).toMatchObject({
      code: "invalid_provider_output",
      message: "Invalid JSON input for streamed tool call weather"
    })
  })

  it("maps every Anthropic stop reason, including ones it does not know", () => {
    const settle = (reason: string): ModelEvent | undefined =>
      replay([
        `{"type":"message_delta","delta":{"stop_reason":${JSON.stringify(reason)}}}`,
        "{\"type\":\"message_stop\"}"
      ]).at(-1)

    expect(settle("end_turn")).toMatchObject({ stopReason: "stop" })
    expect(settle("stop_sequence")).toMatchObject({ stopReason: "stop" })
    expect(settle("pause_turn")).toMatchObject({ stopReason: "stop" })
    expect(settle("max_tokens")).toMatchObject({ stopReason: "length" })
    expect(settle("tool_use")).toMatchObject({ stopReason: "tool-calls" })
    expect(settle("refusal")).toMatchObject({ stopReason: "content-filter" })
    expect(settle("model_context_window_exceeded")).toMatchObject({ stopReason: "unknown" })
    // No message_delta at all still settles, as `unknown`.
    expect(replay(["{\"type\":\"message_stop\"}"])).toEqual([
      { type: "settle", stopReason: "unknown", responseId: undefined }
    ])
  })

  it("keeps partial usage reports and their totals independent", () => {
    expect(replay([
      "{\"type\":\"message_start\",\"message\":{\"usage\":{}}}",
      "{\"type\":\"message_stop\"}"
    ])).toEqual([
      { type: "usage" },
      { type: "settle", stopReason: "unknown", responseId: undefined }
    ])

    expect(replay([
      "{\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":11}}}",
      "{\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"}}",
      "{\"type\":\"message_stop\"}"
    ])).toEqual([
      { type: "usage", inputTokens: 11, totalTokens: 11 },
      { type: "settle", stopReason: "stop", responseId: undefined }
    ])

    expect(replay([
      "{\"type\":\"message_start\",\"message\":{\"usage\":{\"cache_read_input_tokens\":6,\"cache_creation_input_tokens\":null}}}",
      "{\"type\":\"message_delta\",\"usage\":{\"output_tokens\":4}}"
    ])).toEqual([
      { type: "usage", inputTokens: 6, outputTokens: 4, cachedInputTokens: 6, totalTokens: 10 }
    ])

    // Two counter-free reports merge into a counter-free report rather than
    // into zeros, because a missing count is not a zero count.
    expect(replay([
      "{\"type\":\"message_start\",\"message\":{\"usage\":{}}}",
      "{\"type\":\"message_delta\",\"usage\":{}}"
    ])).toEqual([{ type: "usage" }])
  })

  it("carries a response id forward and settles a stream only once", () => {
    const events = replay([
      "{\"type\":\"message_start\",\"message\":{\"id\":\"msg_dup\",\"usage\":{\"input_tokens\":1}}}",
      "{\"type\":\"message_start\",\"message\":{\"usage\":{\"output_tokens\":2}}}",
      "{\"type\":\"message_delta\",\"usage\":{\"output_tokens\":2},\"delta\":{}}",
      "{\"type\":\"message_stop\"}",
      "{\"type\":\"message_stop\"}"
    ])

    expect(events).toEqual([
      { type: "usage", inputTokens: 1, outputTokens: 2, totalTokens: 3 },
      { type: "settle", stopReason: "unknown", responseId: "msg_dup" }
    ])
  })

  it("closes every block an interrupted stream left open", () => {
    expect(replay([
      "{\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\"}}",
      "{\"type\":\"content_block_start\",\"index\":1,\"content_block\":{\"type\":\"thinking\",\"thinking\":\"open\"}}",
      "{\"type\":\"content_block_start\",\"index\":2,\"content_block\":{\"type\":\"thinking\",\"signature\":\"sig\"}}"
    ], true)).toEqual([
      { type: "text-start", id: "text-0" },
      { type: "thinking-start", id: "thinking-2", signature: "sig" },
      { type: "text-end", id: "text-0" },
      { type: "thinking-start", id: "thinking-1", signature: undefined },
      { type: "thinking-delta", id: "thinking-1", text: "open" },
      { type: "thinking-end", id: "thinking-1" },
      { type: "thinking-end", id: "thinking-2" }
    ])
  })

  it("emits no tool end for a duplicated tool id whose call was already completed", () => {
    const events = replay([
      "{\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"tool_use\",\"id\":\"toolu_same\",\"name\":\"weather\"}}",
      "{\"type\":\"content_block_start\",\"index\":1,\"content_block\":{\"type\":\"tool_use\",\"id\":\"toolu_same\",\"name\":\"weather\"}}",
      "{\"type\":\"content_block_delta\",\"index\":1,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"{\\\"city\\\":\\\"Rome\\\"}\"}}",
      "{\"type\":\"content_block_stop\",\"index\":1}"
    ], true)

    expect(events.filter((event) => event.type === "tool-call-end")).toEqual([
      { type: "tool-call-end", id: "toolu_same", arguments: "{\"city\":\"Rome\"}" }
    ])
  })

  it("maps stream error events to ModelError", () => {
    const frame = {
      event: "error",
      data: "{\"type\":\"error\",\"error\":{\"type\":\"overloaded_error\",\"message\":\"Overloaded\"}}"
    }
    const event = Schema.decodeUnknownSync(AnthropicMessages.protocol.stream.event)(frame.data)
    const error = Effect.runSync(
      AnthropicMessages.protocol.stream
        .step(AnthropicMessages.protocol.stream.initial(streamRequest), event)
        .pipe(Effect.flip)
    )
    expect(error).toBeInstanceOf(ModelError)
    expect(error).toMatchObject({ code: "provider_internal", providerCode: "overloaded_error" })
  })

  it("names a stream error even when the provider sends neither type nor message", () => {
    expect(replayError(["{\"type\":\"error\"}"])).toMatchObject({
      code: "unknown",
      message: "Anthropic Messages stream error",
      providerCode: undefined
    })
    expect(replayError(["{\"type\":\"error\",\"error\":{\"type\":\"authentication_error\"}}"])).toMatchObject({
      code: "authentication",
      message: "authentication_error: Anthropic Messages stream error"
    })
    expect(replayError(["{\"type\":\"error\",\"error\":{\"message\":\"blocked for safety\"}}"])).toMatchObject({
      code: "content_policy",
      message: "blocked for safety"
    })
  })
})

describe("AnthropicMessages body lowering", () => {
  it("produces byte-identical canonical bodies from differently ordered inputs", () => {
    const left = body(activatedRequest("claude-sonnet-4-5"))
    const right = body(activatedRequest("claude-sonnet-4-5", {
      reverseRequest: true,
      reverseProperties: true
    }))
    expect(CanonicalJson.stringify(left)).toBe(CanonicalJson.stringify(right))
  })

  it("emits pi's exact nested tool-reference wire shape", () => {
    const requestBody = body(activatedRequest("claude-sonnet-4-5"))

    // Pi findings §4: these literals are the provider's exact wire extension.
    expect(requestBody.tools).toEqual([
      {
        name: "search_tools",
        description: "search_tools description",
        input_schema: {
          type: "object",
          properties: {
            city: { type: "string" },
            days: { type: "number" }
          }
        }
      },
      {
        name: "weather",
        description: "weather description",
        input_schema: {
          type: "object",
          properties: {
            city: { type: "string" },
            days: { type: "number" }
          }
        },
        defer_loading: true
      }
    ])
    expect(requestBody.messages[1]).toEqual({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_loader",
          content: [{
            type: "tool_reference",
            tool_name: "weather"
          }]
        },
        {
          type: "text",
          text: "Found weather"
        }
      ]
    })
    expect(Object.keys(requestBody.tools?.[1] ?? {}).sort()).toEqual([
      "defer_loading",
      "description",
      "input_schema",
      "name"
    ])
  })

  it("marks an unactivated declared tool as lazy on the initial native request", () => {
    const requestBody = body(
      ModelRequest.make({
        modelId: "claude-sonnet-4-5",
        system: [],
        messages: [],
        tools: [
          tool("search_tools", { loader: true }),
          tool("weather", { deferred: true })
        ],
        params: GenerationParams.make()
      })
    )

    expect(requestBody.tools).toEqual([
      {
        name: "search_tools",
        description: "search_tools description",
        input_schema: {
          type: "object",
          properties: {
            city: { type: "string" },
            days: { type: "number" }
          }
        }
      },
      {
        name: "weather",
        description: "weather description",
        input_schema: {
          type: "object",
          properties: {
            city: { type: "string" },
            days: { type: "number" }
          }
        },
        defer_loading: true
      }
    ])
  })

  it("emits an activated tool reference only once across the transcript", () => {
    const modelRequest = activatedRequest("claude-sonnet-4-5")
    const repeated = ModelRequest.make({
      ...modelRequest,
      messages: [
        ...modelRequest.messages,
        Message.tool(ToolResultPart.make({
          toolCallId: "toolu_loader_again",
          content: "Already loaded",
          addedToolNames: ["WEATHER", "weather"]
        }))
      ]
    })
    const encoded = CanonicalJson.stringify(body(repeated))
    expect(encoded.match(/"type":"tool_reference"/g)).toHaveLength(1)
    expect(encoded).toContain("\"content\":\"Already loaded\"")
  })

  it("falls back to the full tool list on unsupported models", () => {
    const request = activatedRequest("claude-haiku")
    const requestBody = body(request)
    expect(requestBody.tools).toHaveLength(2)
    expect(CanonicalJson.stringify(requestBody)).not.toContain("defer_loading")
    expect(CanonicalJson.stringify(requestBody)).not.toContain("tool_reference")
  })

  it("keeps inactive lazy tools out of an unsupported model's initial active list", () => {
    const requestBody = body(
      ModelRequest.make({
        modelId: "claude-haiku",
        system: [],
        messages: [],
        tools: [
          tool("search_tools", { loader: true }),
          tool("weather", { deferred: true })
        ],
        params: GenerationParams.make()
      })
    )

    expect(requestBody.tools?.map((entry) => entry.name)).toEqual(["search_tools"])
    expect(CanonicalJson.stringify(requestBody)).not.toContain("defer_loading")
  })

  it("omits aborted and errored assistant turns and unsigned thinking", () => {
    const request = ModelRequest.make({
      modelId: "claude-sonnet-4-5",
      system: [],
      messages: [
        Message.user("before"),
        Message.assistant("partial", { stopReason: "aborted" }),
        Message.assistant("failed", { stopReason: "error" }),
        Message.assistant([
          ThinkingPart.make({ text: "complete", signature: "signed" }),
          ThinkingPart.make({ text: "incomplete" }),
          { type: "text", text: "answer" }
        ], { stopReason: "stop" })
      ],
      tools: [],
      params: GenerationParams.make()
    })
    const requestBody = body(request)
    expect(requestBody.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "before" }] },
      {
        role: "assistant",
        content: [
          {
            type: "thinking",
            thinking: "complete",
            signature: "signed"
          },
          { type: "text", text: "answer" }
        ]
      }
    ])
  })

  it("delegates deferred support and classifies provider failures", () => {
    expect(AnthropicMessages.protocol.supportsDeferred("claude-opus-4-5")).toBe(true)
    expect(AnthropicMessages.protocol.supportsDeferred("claude-haiku")).toBe(false)
    expect(
      AnthropicMessages.protocol.classifyError(
        429,
        "{\"error\":{\"type\":\"rate_limit_error\",\"message\":\"Slow down\"}}"
      )
    ).toMatchObject({
      code: "rate_limited",
      providerCode: "rate_limit_error",
      httpStatus: 429
    })
  })

  it("classifies every HTTP failure shape, including bodies it cannot parse", () => {
    const classify = AnthropicMessages.protocol.classifyError

    expect(classify(401, "{}")).toMatchObject({
      code: "authentication",
      message: "Anthropic Messages request failed with HTTP 401",
      providerCode: undefined,
      httpStatus: 401
    })
    expect(classify(403, "{\"error\":{\"type\":\"permission_error\",\"message\":\"no access\"}}")).toMatchObject({
      code: "authentication"
    })
    expect(classify(500, "<html>gateway</html>")).toMatchObject({
      code: "provider_internal",
      message: "Anthropic Messages request failed with HTTP 500"
    })
    expect(classify(529, "{\"error\":{\"type\":\"overloaded_error\",\"message\":\"Overloaded\"}}")).toMatchObject({
      code: "provider_internal"
    })
    expect(classify(418, "{\"error\":{\"type\":\"api_error\",\"message\":\"teapot\"}}")).toMatchObject({
      code: "provider_internal"
    })
    expect(classify(418, "{\"error\":{\"type\":\"tea_error\",\"message\":\"teapot\"}}")).toMatchObject({
      code: "unknown"
    })
    expect(classify(400, "{\"error\":{\"type\":\"invalid_request_error\",\"message\":\"unsafe content\"}}"))
      .toMatchObject({ code: "invalid_request" })
    expect(classify(400, "{\"error\":{\"type\":\"invalid_request_error\",\"message\":\"blocked by safety\"}}"))
      .toMatchObject({ code: "content_policy" })
  })

  it("rejects a tool call whose recorded arguments are not a JSON object", () => {
    const invalid = (arguments_: string) =>
      Effect.runSync(
        AnthropicMessages.protocol.body.from(
          ModelRequest.make({
            modelId: "claude-sonnet-4-5",
            system: [],
            messages: [
              Message.assistant(ToolCallPart.make({ id: "toolu_1", name: "weather", arguments: arguments_ }), {
                stopReason: "tool-calls"
              })
            ],
            tools: [],
            params: GenerationParams.make()
          }),
          { native: true }
        ).pipe(Effect.flip)
      )

    expect(invalid("not json")).toMatchObject({
      code: "invalid_request",
      message: "Anthropic Messages tool-call arguments must be a JSON object"
    })
    expect(invalid("[1,2]")).toMatchObject({ code: "invalid_request" })
    expect(invalid("")).toMatchObject({ code: "invalid_request" })
  })

  it("drops message parts no Anthropic wire block represents", () => {
    const untyped = {
      modelId: "claude-sonnet-4-5",
      system: [],
      messages: [
        { role: "user", content: [{ type: "thinking", text: "not user content" }] },
        {
          role: "assistant",
          content: [{ type: "tool-result", toolCallId: "call", content: "not assistant content" }],
          stopReason: "stop"
        }
      ],
      tools: [],
      params: GenerationParams.make()
    } as unknown as ModelRequest

    expect(body(untyped).messages).toEqual([
      { role: "user", content: [] },
      { role: "assistant", content: [] }
    ])
  })

  it("lowers every sampling knob and omits the ones left unset", () => {
    const withParams = (params: GenerationParams): AnthropicMessages.Body =>
      body(
        ModelRequest.make({
          modelId: "claude-sonnet-4-5",
          system: [],
          messages: [],
          tools: [],
          params
        })
      )

    expect(withParams(GenerationParams.make({
      maxTokens: 256,
      temperature: 0.5,
      topP: 0.9,
      topK: 40,
      stopSequences: ["END"],
      thinkingBudget: 1_024
    }))).toEqual({
      model: "claude-sonnet-4-5",
      max_tokens: 256,
      messages: [],
      stream: true,
      temperature: 0.5,
      top_p: 0.9,
      top_k: 40,
      stop_sequences: ["END"],
      thinking: { type: "enabled", budget_tokens: 1_024 }
    })

    // An empty stop-sequence list is not a stop-sequence list, and an unset
    // token budget leaves Anthropic's own default in place.
    expect(withParams(GenerationParams.make({ stopSequences: [] }))).toEqual({
      model: "claude-sonnet-4-5",
      max_tokens: 4_096,
      messages: [],
      stream: true
    })
    expect(withParams(GenerationParams.make({ maxTokens: 0, thinkingBudget: 0 }))).toMatchObject({
      max_tokens: 0,
      thinking: { type: "enabled", budget_tokens: 0 }
    })
    // The Responses-only effort knob never reaches an Anthropic body.
    expect(CanonicalJson.stringify(withParams(GenerationParams.make({ reasoningEffort: "high" })))).not.toContain(
      "high"
    )
  })

  it("classifies an oversized prompt as context_overflow, not as a bad request", () => {
    // Anthropic's own shape: a 400 typed `invalid_request_error` whose message
    // is the only thing that says the request did not fit.
    expect(
      AnthropicMessages.protocol.classifyError(
        400,
        "{\"error\":{\"type\":\"invalid_request_error\",\"message\":\"prompt is too long: 250000 tokens > 200000 maximum\"}}"
      )
    ).toMatchObject({
      code: "context_overflow",
      providerCode: "invalid_request_error",
      httpStatus: 400
    })
    // Any other 400 stays an ordinary bad request; overflow is not a catch-all.
    expect(
      AnthropicMessages.protocol.classifyError(
        400,
        "{\"error\":{\"type\":\"invalid_request_error\",\"message\":\"tools.0.name: invalid value\"}}"
      )
    ).toMatchObject({ code: "invalid_request" })
  })
})
