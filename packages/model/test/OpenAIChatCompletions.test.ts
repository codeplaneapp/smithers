import { Effect, Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as Events from "../src/ModelEvent.ts"
import * as Request from "../src/ModelRequest.ts"
import * as OpenAIChatCompletions from "../src/OpenAIChatCompletions.ts"

const streamRequest = Request.ModelRequest.make({
  modelId: "qwen2.5:3b",
  system: [],
  messages: [],
  tools: [],
  params: Request.GenerationParams.make()
})

const step = (
  state: ReturnType<typeof OpenAIChatCompletions.protocol.stream.initial>,
  data: string
) => {
  const event = Schema.decodeUnknownSync(OpenAIChatCompletions.protocol.stream.event)(data)
  return Effect.runSync(OpenAIChatCompletions.protocol.stream.step(state, event))
}

const replayData = (data: ReadonlyArray<string>): ReadonlyArray<Events.ModelEvent> => {
  let state = OpenAIChatCompletions.protocol.stream.initial(streamRequest)
  const events: Array<Events.ModelEvent> = []
  for (const datum of data) {
    const [next, emitted] = step(state, datum)
    state = next
    events.push(...emitted)
  }
  events.push(...(OpenAIChatCompletions.protocol.stream.onHalt?.(state) ?? []))
  return events
}

const body = (request: Request.ModelRequest): OpenAIChatCompletions.Body =>
  Effect.runSync(OpenAIChatCompletions.protocol.body.from(request, { native: false }))

describe("OpenAIChatCompletions.protocol.body", () => {
  it("lowers system, user, assistant tool-call, and tool-result messages", () => {
    const request = Request.ModelRequest.make({
      modelId: "gemini-2.5-flash-lite",
      system: [Request.SystemPart.make({ text: "Be terse." })],
      messages: [
        Request.Message.user("What is the capital of France?"),
        Request.Message.assistant(
          Request.ToolCallPart.make({ id: "call_1", name: "search", arguments: "{\"q\":\"France\"}" }),
          {
            stopReason: "tool-calls"
          }
        ),
        Request.Message.tool(Request.ToolResultPart.make({ toolCallId: "call_1", content: "Paris" }))
      ],
      tools: [Request.ToolDefinition.make({ name: "search", description: "web search", parameters: {} })],
      params: Request.GenerationParams.make()
    })
    const decoded = body(request)
    expect(decoded.model).toBe("gemini-2.5-flash-lite")
    expect(decoded.stream).toBe(true)
    expect(decoded.messages).toEqual([
      { role: "system", content: "Be terse." },
      { role: "user", content: "What is the capital of France?" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "call_1", type: "function", function: { name: "search", arguments: "{\"q\":\"France\"}" } }]
      },
      { role: "tool", tool_call_id: "call_1", content: "Paris" }
    ])
    expect(decoded.tools).toEqual([
      { type: "function", function: { name: "search", description: "web search", parameters: {} } }
    ])
  })

  it("omits an aborted or errored historical assistant turn", () => {
    const request = Request.ModelRequest.make({
      modelId: "gemini-2.5-flash-lite",
      system: [],
      messages: [Request.Message.assistant("partial", { stopReason: "aborted" })],
      tools: [],
      params: Request.GenerationParams.make()
    })
    expect(body(request).messages).toEqual([])
  })
})

describe("OpenAIChatCompletions.protocol.stream", () => {
  it("replays a plain-text completion captured from a real Ollama server", () => {
    const events = replayData([
      "{\"id\":\"chatcmpl-709\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"Paris\"},\"finish_reason\":null}]}",
      "{\"id\":\"chatcmpl-709\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"\"},\"finish_reason\":\"stop\"}]}",
      "{\"id\":\"chatcmpl-709\",\"choices\":[],\"usage\":{\"prompt_tokens\":29,\"completion_tokens\":2,\"total_tokens\":31}}"
    ])
    expect(events).toEqual([
      Events.ModelEvent.TextStart({ type: "text-start", id: "text-0" }),
      Events.ModelEvent.TextDelta({ type: "text-delta", id: "text-0", text: "Paris" }),
      Events.ModelEvent.TextEnd({ type: "text-end", id: "text-0" }),
      Events.ModelEvent.Settle({ type: "settle", stopReason: "stop" }),
      Events.ModelEvent.Usage({ inputTokens: 29, outputTokens: 2, totalTokens: 31 })
    ])
  })

  it("replays a tool-call completion captured from a real Ollama server", () => {
    const events = replayData([
      "{\"id\":\"chatcmpl-204\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"\",\"tool_calls\":[{\"id\":\"call_sx8k7q8i\",\"index\":0,\"type\":\"function\",\"function\":{\"name\":\"answer\",\"arguments\":\"{\\\"answer\\\":\\\"Paris\\\"}\"}}]},\"finish_reason\":null}]}",
      "{\"id\":\"chatcmpl-204\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"\"},\"finish_reason\":\"tool_calls\"}]}",
      "{\"id\":\"chatcmpl-204\",\"choices\":[],\"usage\":{\"prompt_tokens\":155,\"completion_tokens\":29,\"total_tokens\":184}}"
    ])
    expect(events).toEqual([
      Events.ModelEvent.ToolCallStart({ type: "tool-call-start", id: "call_sx8k7q8i", name: "answer" }),
      Events.ModelEvent.ToolCallDelta({
        type: "tool-call-delta",
        id: "call_sx8k7q8i",
        arguments: "{\"answer\":\"Paris\"}"
      }),
      Events.ModelEvent.ToolCallEnd({
        type: "tool-call-end",
        id: "call_sx8k7q8i",
        arguments: "{\"answer\":\"Paris\"}"
      }),
      Events.ModelEvent.Settle({ type: "settle", stopReason: "tool-calls" }),
      Events.ModelEvent.Usage({ inputTokens: 155, outputTokens: 29, totalTokens: 184 })
    ])
  })

  it("accumulates a tool call streamed across multiple argument-only deltas", () => {
    const events = replayData([
      "{\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"id\":\"call_1\",\"index\":0,\"type\":\"function\",\"function\":{\"name\":\"answer\",\"arguments\":\"{\\\"a\"}}]},\"finish_reason\":null}]}",
      "{\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"nswer\\\":\\\"Paris\\\"}\"}}]},\"finish_reason\":null}]}",
      "{\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"tool_calls\"}]}"
    ])
    const end = events.find((event): event is Events.ToolCallEnd => event.type === "tool-call-end")
    expect(end?.arguments).toBe("{\"answer\":\"Paris\"}")
  })

  it("settles once on a defect malformed chunk carrying an inline error", () => {
    const result = Effect.runSync(
      Effect.flip(
        OpenAIChatCompletions.protocol.stream.step(
          OpenAIChatCompletions.protocol.stream.initial(streamRequest),
          Schema.decodeUnknownSync(OpenAIChatCompletions.protocol.stream.event)(
            "{\"error\":{\"message\":\"model overloaded\",\"code\":\"overloaded\"}}"
          )
        )
      )
    )
    expect(result.code).toBe("provider_internal")
    expect(result.message).toBe("model overloaded")
  })

  it("maps every finish_reason to its provider-neutral stop reason", () => {
    const reasonFor = (finishReason: string): string => {
      const events = replayData([`{"choices":[{"index":0,"delta":{},"finish_reason":"${finishReason}"}]}`])
      const settle = events.find((event): event is Events.Settle => event.type === "settle")
      return settle?.stopReason ?? "missing"
    }
    expect(reasonFor("stop")).toBe("stop")
    expect(reasonFor("length")).toBe("length")
    expect(reasonFor("tool_calls")).toBe("tool-calls")
    expect(reasonFor("content_filter")).toBe("content-filter")
    expect(reasonFor("something_unrecognized")).toBe("unknown")
  })
})

describe("OpenAIChatCompletions.protocol.classifyError", () => {
  it("classifies a real Gemini 429 rate-limit body, even array-wrapped", () => {
    const error = OpenAIChatCompletions.protocol.classifyError(
      429,
      "[{\"error\":{\"code\":429,\"message\":\"You exceeded your current quota\",\"status\":\"RESOURCE_EXHAUSTED\"}}]"
    )
    expect(error.httpStatus).toBe(429)
    expect(error.code).toBe("rate_limited")
  })

  it("classifies an authentication failure by status code", () => {
    const error = OpenAIChatCompletions.protocol.classifyError(401, "{\"error\":{\"message\":\"invalid api key\"}}")
    expect(error.code).toBe("authentication")
  })

  it("classifies quota exhaustion by message content", () => {
    const error = OpenAIChatCompletions.protocol.classifyError(
      400,
      "{\"error\":{\"message\":\"You have no credits remaining\"}}"
    )
    expect(error.code).toBe("quota_exceeded")
  })

  it("falls back to a generic message when the body is not JSON", () => {
    const error = OpenAIChatCompletions.protocol.classifyError(500, "internal server error, not json")
    expect(error.code).toBe("provider_internal")
    expect(error.message).toBe("Chat Completions request failed with HTTP 500")
  })
})
