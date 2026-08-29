/**
 * OpenAI Chat Completions request lowering and SSE event handling.
 *
 * This is the older, widely-cloned OpenAI wire shape — distinct from
 * {@link OpenAIResponses}, which targets api.openai.com's newer Responses
 * API. Every self-hosted or third-party "OpenAI-compatible" endpoint that
 * does not implement Responses (Ollama, Gemini's compatibility layer, and
 * most others) speaks this one instead, so it is the protocol a generic
 * `openaiCompatible` route needs.
 *
 * @since 0.1.0
 */
import { Effect, Option, Schema } from "effect"
import { isContextOverflow, ModelError } from "./ModelError.ts"
import * as ModelEvent from "./ModelEvent.ts"
import { JsonObject, type Message, type ModelRequest, type StopReason, type ToolDefinition } from "./ModelRequest.ts"
import * as Protocol from "./Protocol.ts"
import * as ToolStream from "./ToolStream.ts"

const FunctionTool = Schema.Struct({
  type: Schema.Literal("function"),
  function: Schema.Struct({
    name: Schema.String,
    description: Schema.String,
    parameters: JsonObject
  })
})

type FunctionTool = typeof FunctionTool.Type

const ToolCallRef = Schema.Struct({
  id: Schema.String,
  type: Schema.Literal("function"),
  function: Schema.Struct({ name: Schema.String, arguments: Schema.String })
})

const ChatMessage = Schema.Union([
  Schema.Struct({ role: Schema.Literal("system"), content: Schema.String }),
  Schema.Struct({ role: Schema.Literal("user"), content: Schema.String }),
  Schema.Struct({
    role: Schema.Literal("assistant"),
    content: Schema.NullOr(Schema.String),
    tool_calls: Schema.optional(Schema.Array(ToolCallRef))
  }),
  Schema.Struct({
    role: Schema.Literal("tool"),
    tool_call_id: Schema.String,
    content: Schema.String
  })
])

type ChatMessage = typeof ChatMessage.Type

/**
 * JSON schema for a Chat Completions request body.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Body = Schema.Struct({
  model: Schema.String,
  messages: Schema.Array(ChatMessage),
  tools: Schema.optional(Schema.Array(FunctionTool)),
  max_tokens: Schema.optional(Schema.Finite),
  temperature: Schema.optional(Schema.Finite),
  top_p: Schema.optional(Schema.Finite),
  stream: Schema.Literal(true),
  stream_options: Schema.optional(Schema.Struct({ include_usage: Schema.Literal(true) }))
})

/**
 * The decoded form of the Chat Completions request body.
 *
 * @category models
 * @since 0.1.0
 */
export type Body = typeof Body.Type

const functionTool = (tool: ToolDefinition): FunctionTool => ({
  type: "function",
  function: { name: tool.name, description: tool.description, parameters: tool.parameters }
})

const systemMessage = (request: ModelRequest): ReadonlyArray<ChatMessage> => {
  const text = request.system.map((part) => part.text).join("\n")
  return text === "" ? [] : [{ role: "system", content: text }]
}

const assistantToolCalls = (
  message: Extract<Message, { readonly role: "assistant" }>
): ReadonlyArray<typeof ToolCallRef.Type> =>
  message.content.flatMap((part) =>
    part.type === "tool-call"
      ? [{ id: part.id, type: "function" as const, function: { name: part.name, arguments: part.arguments } }]
      : []
  )

const lowerMessages = (request: ModelRequest): ReadonlyArray<ChatMessage> => {
  const messages: Array<ChatMessage> = [...systemMessage(request)]
  for (const message of request.messages) {
    if (message.role === "user") {
      messages.push({ role: "user", content: message.content.map((part) => part.text).join("") })
      continue
    }
    if (message.role === "assistant") {
      // A historically aborted or errored turn carries no wire-valid content;
      // omitting it lets the next user input resume cleanly, matching
      // OpenAIResponses's own handling of the same case.
      if (message.stopReason === "aborted" || message.stopReason === "error") continue
      const text = message.content.filter((part) => part.type === "text").map((part) => part.text).join("")
      const toolCalls = assistantToolCalls(message)
      messages.push({
        role: "assistant",
        content: text === "" && toolCalls.length > 0 ? null : text,
        ...(toolCalls.length === 0 ? {} : { tool_calls: toolCalls })
      })
      continue
    }
    for (const result of message.content) {
      messages.push({ role: "tool", tool_call_id: result.toolCallId, content: result.content })
    }
  }
  return messages
}

const buildBody = (request: ModelRequest): Body => ({
  model: request.modelId,
  messages: lowerMessages(request),
  ...(request.tools.length === 0 ? {} : { tools: request.tools.map(functionTool) }),
  ...(request.params.maxTokens === undefined ? {} : { max_tokens: request.params.maxTokens }),
  ...(request.params.temperature === undefined ? {} : { temperature: request.params.temperature }),
  ...(request.params.topP === undefined ? {} : { top_p: request.params.topP }),
  stream: true,
  stream_options: { include_usage: true }
})

const fromRequest = Effect.fn("OpenAIChatCompletions.fromRequest")((
  request: ModelRequest
): Effect.Effect<Body, ModelError> => Effect.succeed(buildBody(request)))

const ChunkToolCall = Schema.Struct({
  index: Schema.Number,
  id: Schema.optional(Schema.String),
  function: Schema.optional(Schema.Struct({
    name: Schema.optional(Schema.String),
    arguments: Schema.optional(Schema.String)
  }))
})

const ChunkDelta = Schema.Struct({
  role: Schema.optional(Schema.String),
  content: Schema.optional(Schema.NullOr(Schema.String)),
  tool_calls: Schema.optional(Schema.Array(ChunkToolCall))
})

const ChunkUsage = Schema.Struct({
  prompt_tokens: Schema.optional(Schema.Number),
  completion_tokens: Schema.optional(Schema.Number),
  total_tokens: Schema.optional(Schema.Number)
})

const ChatCompletionChunk = Schema.Struct({
  id: Schema.optional(Schema.String),
  choices: Schema.optional(Schema.Array(Schema.Struct({
    index: Schema.optional(Schema.Number),
    delta: Schema.optional(ChunkDelta),
    finish_reason: Schema.optional(Schema.NullOr(Schema.String))
  }))),
  usage: Schema.optional(Schema.NullOr(ChunkUsage)),
  error: Schema.optional(JsonObject)
})

type ChatCompletionChunk = typeof ChatCompletionChunk.Type

/**
 * What the adapter must carry between chunks of one Chat Completions stream:
 * whether the (single, id-less) text part has opened, and the in-flight tool
 * calls keyed by their stream position, since a delta only ever repeats the
 * provider tool call's array `index` — the `id` and `function.name` arrive
 * once, on the first delta for that index.
 *
 * @category models
 * @since 0.1.0
 */
export interface State {
  readonly tools: ToolStream.State
  readonly callIdByIndex: Readonly<Record<number, string>>
  readonly textOpen: boolean
  readonly settled: boolean
}

const TEXT_ID = "text-0"

const usageEvent = (usage: typeof ChunkUsage.Type | null | undefined): ModelEvent.ModelEvent | undefined =>
  usage === null || usage === undefined ? undefined : ModelEvent.ModelEvent.Usage({
    inputTokens: usage.prompt_tokens,
    outputTokens: usage.completion_tokens,
    totalTokens: usage.total_tokens
  })

const stopReasonOf = (reason: string): StopReason =>
  reason === "stop"
    ? "stop"
    : reason === "length"
    ? "length"
    : reason === "tool_calls"
    ? "tool-calls"
    : reason === "content_filter"
    ? "content-filter"
    : "unknown"

const settle = (
  state: State,
  stopReason: StopReason
): { readonly state: State; readonly events: ReadonlyArray<ModelEvent.ModelEvent> } =>
  state.settled
    ? { state, events: [] }
    : {
      state: { ...state, settled: true },
      events: [
        ...(state.textOpen ? [ModelEvent.ModelEvent.TextEnd({ type: "text-end", id: TEXT_ID })] : []),
        ModelEvent.ModelEvent.Settle({ type: "settle", stopReason })
      ]
    }

const stepToolCall = (
  state: State,
  call: typeof ChunkToolCall.Type
): { readonly state: State; readonly events: ReadonlyArray<ModelEvent.ModelEvent> } | ModelError => {
  const existingId = state.callIdByIndex[call.index]
  if (existingId === undefined) {
    const id = call.id ?? `tool-${call.index}`
    const name = call.function?.name
    if (name === undefined) {
      return new ModelError({
        code: "invalid_provider_output",
        message: "Chat Completions opened a tool call without a name"
      })
    }
    const initialArguments = call.function?.arguments
    const tools = initialArguments === undefined || initialArguments === ""
      ? ToolStream.start(state.tools, { callId: id, name })
      : ToolStream.delta(ToolStream.start(state.tools, { callId: id, name }), id, initialArguments)
    return {
      state: { ...state, tools, callIdByIndex: { ...state.callIdByIndex, [call.index]: id } },
      events: [
        ModelEvent.ModelEvent.ToolCallStart({ type: "tool-call-start", id, name }),
        ...(initialArguments === undefined || initialArguments === ""
          ? []
          : [ModelEvent.ModelEvent.ToolCallDelta({ type: "tool-call-delta", id, arguments: initialArguments })])
      ]
    }
  }
  const fragment = call.function?.arguments
  if (fragment === undefined || fragment === "") return { state, events: [] }
  return {
    state: { ...state, tools: ToolStream.delta(state.tools, existingId, fragment) },
    events: [ModelEvent.ModelEvent.ToolCallDelta({ type: "tool-call-delta", id: existingId, arguments: fragment })]
  }
}

const stepEvent = (
  state: State,
  event: ChatCompletionChunk
): { readonly state: State; readonly events: ReadonlyArray<ModelEvent.ModelEvent> } | ModelError => {
  if (event.error !== undefined) {
    const error = event.error as { readonly message?: unknown; readonly code?: unknown }
    return new ModelError({
      code: "provider_internal",
      message: typeof error.message === "string" ? error.message : "Chat Completions stream reported an error",
      providerCode: typeof error.code === "string" ? error.code : undefined
    })
  }
  const usage = usageEvent(event.usage)
  // Both Ollama and api.openai.com send one final, choice-less chunk carrying
  // only `usage` after the chunk with `finish_reason`, so it must be read
  // even once `state.settled` is already true; nothing else may run past
  // settlement.
  if (state.settled) return { state, events: usage === undefined ? [] : [usage] }
  const choice = event.choices?.[0]
  if (choice === undefined) return { state, events: usage === undefined ? [] : [usage] }
  const delta = choice.delta
  const events: Array<ModelEvent.ModelEvent> = usage === undefined ? [] : [usage]
  let current = state
  if (delta?.content !== undefined && delta.content !== null && delta.content !== "") {
    if (!current.textOpen) {
      current = { ...current, textOpen: true }
      events.push(ModelEvent.ModelEvent.TextStart({ type: "text-start", id: TEXT_ID }))
    }
    events.push(ModelEvent.ModelEvent.TextDelta({ type: "text-delta", id: TEXT_ID, text: delta.content }))
  }
  for (const call of delta?.tool_calls ?? []) {
    const result = stepToolCall(current, call)
    if (result instanceof ModelError) return result
    current = result.state
    events.push(...result.events)
  }
  if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
    // Every open tool call closes when the provider signals it stopped for
    // tool calls: Chat Completions never sends a per-call "done" event the
    // way Responses does, only the aggregate `finish_reason`.
    for (const [index, callId] of Object.entries(current.callIdByIndex)) {
      void index
      const ended = ToolStream.end(current.tools, callId)
      if (ended instanceof ModelError) return ended
      current = { ...current, tools: ended.state }
      events.push(
        ModelEvent.ModelEvent.ToolCallEnd({ type: "tool-call-end", id: callId, arguments: ended.completed.arguments })
      )
    }
    const terminal = settle(current, stopReasonOf(choice.finish_reason))
    return { state: terminal.state, events: [...events, ...terminal.events] }
  }
  return { state: current, events }
}

const step = Effect.fn("OpenAIChatCompletions.step")((
  state: State,
  event: ChatCompletionChunk
): Effect.Effect<readonly [State, ReadonlyArray<ModelEvent.ModelEvent>], ModelError> =>
  Effect.suspend(() => {
    const result = stepEvent(state, event)
    return result instanceof ModelError ? Effect.fail(result) : Effect.succeed([result.state, result.events] as const)
  })
)

const finalize = (state: State): ReadonlyArray<ModelEvent.ModelEvent> =>
  ToolStream.flushAborted(state.tools).completed.map((call) =>
    ModelEvent.ModelEvent.ToolCallEnd({ type: "tool-call-end", id: call.callId, arguments: call.arguments })
  )

const decodeErrorBody = Schema.decodeUnknownOption(Schema.fromJsonString(JsonObject))
const string = (value: unknown): string | undefined => typeof value === "string" ? value : undefined
const record = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : undefined

const providerReason = (status: number, code: string | undefined, message: string): ModelError["code"] => {
  const normalized = `${code ?? ""} ${message}`.toLowerCase()
  if (
    /insufficient[-_]?quota|quota[-_]?exceeded|billing[-_]?hard[-_]?limit|credit[-_]?balance|no credits/.test(
      normalized
    )
  ) {
    return "quota_exceeded"
  }
  if (
    status === 401 || status === 403 || /authentication|invalid[-_]?api[-_]?key|permission[-_]?denied/.test(normalized)
  ) {
    return "authentication"
  }
  if (status === 429 || /rate[-_]?limit|too many requests/.test(normalized)) return "rate_limited"
  if (/content[-_]?policy|content[-_]?filter|safety/.test(normalized)) return "content_policy"
  if (isContextOverflow(code, message)) return "context_overflow"
  if (
    status === 400 || status === 404 || status === 409 || status === 413 || status === 422 ||
    /invalid[-_]?request/.test(normalized)
  ) {
    return "invalid_request"
  }
  if (status >= 500 || /server[-_]?error|internal[-_]?error/.test(normalized)) return "provider_internal"
  return "unknown"
}

const classifyError = (status: number, body: string): ModelError => {
  const decoded = decodeErrorBody(body)
  const parsed = Option.isSome(decoded) ? decoded.value : undefined
  const error = record(record(parsed)?.error) ?? record(parsed)
  const code = string(error?.code) ?? string(error?.type)
  const message = string(error?.message) ?? `Chat Completions request failed with HTTP ${status}`
  return new ModelError({
    code: providerReason(status, code, message),
    message,
    httpStatus: status,
    providerCode: code
  })
}

/**
 * The OpenAI Chat Completions protocol — the wire shape Ollama, Gemini's
 * OpenAI-compatible endpoint, and most other self-hosted or third-party
 * "OpenAI-compatible" servers actually implement.
 *
 * @category models
 * @since 0.1.0
 */
export const protocol: Protocol.Protocol<Body, string, ChatCompletionChunk, State> = Protocol.make({
  id: "openai-chat-completions",
  supportsDeferred: () => false,
  body: {
    schema: Body,
    from: fromRequest
  },
  stream: {
    event: Schema.fromJsonString(ChatCompletionChunk),
    initial: () => ({ tools: ToolStream.initial(), callIdByIndex: {}, textOpen: false, settled: false }),
    step,
    onHalt: finalize
  },
  classifyError
})
