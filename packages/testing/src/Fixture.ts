/**
 * Recorded-model fixture values and their portable decoder.
 *
 * @since 0.0.0
 */
import type { Effect } from "effect"
import { Schema } from "effect"
import type { ModelErrorLike, ModelEventLike, ModelRequestLike } from "./ModelLike.ts"

/**
 * One recorded model invocation.
 *
 * @category models
 * @since 0.0.0
 */
export interface RecordedCall {
  readonly request: ModelRequestLike
  readonly model: string
  readonly events: ReadonlyArray<ModelEventLike>
  readonly failure?: ModelErrorLike | undefined
}

/**
 * A portable recording of model calls.
 *
 * @category models
 * @since 0.0.0
 */
export interface Fixture {
  readonly calls: ReadonlyArray<RecordedCall>
}

const eventSchema = Schema.Union([
  Schema.Struct({ type: Schema.Literal("text-start"), id: Schema.String }),
  Schema.Struct({ type: Schema.Literal("text-delta"), id: Schema.String, text: Schema.String }),
  Schema.Struct({ type: Schema.Literal("text-end"), id: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("thinking-start"),
    id: Schema.String,
    signature: Schema.optionalKey(Schema.String)
  }),
  Schema.Struct({ type: Schema.Literal("thinking-delta"), id: Schema.String, text: Schema.String }),
  Schema.Struct({ type: Schema.Literal("thinking-end"), id: Schema.String }),
  Schema.Struct({ type: Schema.Literal("tool-call-start"), id: Schema.String, name: Schema.String }),
  Schema.Struct({ type: Schema.Literal("tool-call-delta"), id: Schema.String, arguments: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("tool-call-end"),
    id: Schema.String,
    arguments: Schema.optionalKey(Schema.String)
  }),
  Schema.Struct({
    type: Schema.Literal("tool-result"),
    id: Schema.String,
    output: Schema.String,
    isError: Schema.optionalKey(Schema.Boolean)
  }),
  Schema.Struct({
    type: Schema.Literal("usage"),
    inputTokens: Schema.optionalKey(Schema.Number),
    outputTokens: Schema.optionalKey(Schema.Number),
    reasoningTokens: Schema.optionalKey(Schema.Number),
    cachedInputTokens: Schema.optionalKey(Schema.Number),
    cacheWriteTokens: Schema.optionalKey(Schema.Number),
    totalTokens: Schema.optionalKey(Schema.Number)
  }),
  Schema.Struct({
    type: Schema.Literal("retry"),
    attempt: Schema.Int,
    code: Schema.String,
    delayMillis: Schema.Number
  }),
  Schema.Struct({
    type: Schema.Literal("settle"),
    stopReason: Schema.Literals(["stop", "length", "tool-calls", "content-filter", "error", "aborted", "unknown"]),
    responseId: Schema.optionalKey(Schema.String),
    itemIds: Schema.optionalKey(Schema.Array(Schema.String))
  })
])

const stopReasonSchema = Schema.Literals([
  "stop",
  "length",
  "tool-calls",
  "content-filter",
  "error",
  "aborted",
  "unknown"
])

const textPartSchema = Schema.Struct({ type: Schema.Literal("text"), text: Schema.String })

// The message, tool, and params shapes mirror `/model/ModelRequest`
// (read-only; see `ModelLike` for the structural contract), so an invalid
// fixture fails decoding instead of passing through as opaque JSON.
const messageSchema = Schema.Union([
  Schema.Struct({
    role: Schema.Literal("user"),
    content: Schema.Array(textPartSchema)
  }),
  Schema.Struct({
    role: Schema.Literal("assistant"),
    content: Schema.Array(Schema.Union([
      textPartSchema,
      Schema.Struct({
        type: Schema.Literal("thinking"),
        text: Schema.String,
        signature: Schema.optionalKey(Schema.String)
      }),
      Schema.Struct({
        type: Schema.Literal("tool-call"),
        id: Schema.String,
        name: Schema.String,
        arguments: Schema.String
      })
    ])),
    stopReason: stopReasonSchema,
    responseId: Schema.optionalKey(Schema.String),
    itemIds: Schema.optionalKey(Schema.Array(Schema.String))
  }),
  Schema.Struct({
    role: Schema.Literal("tool"),
    content: Schema.Array(Schema.Struct({
      type: Schema.Literal("tool-result"),
      toolCallId: Schema.String,
      content: Schema.String,
      addedToolNames: Schema.Array(Schema.String)
    }))
  })
])

const toolSchema = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  parameters: Schema.Record(Schema.String, Schema.Json),
  deferred: Schema.optionalKey(Schema.Boolean),
  loader: Schema.optionalKey(Schema.Boolean)
})

const paramsSchema = Schema.Struct({
  maxTokens: Schema.optionalKey(Schema.Number),
  temperature: Schema.optionalKey(Schema.Number),
  topP: Schema.optionalKey(Schema.Number),
  topK: Schema.optionalKey(Schema.Number),
  stopSequences: Schema.optionalKey(Schema.Array(Schema.String)),
  thinkingBudget: Schema.optionalKey(Schema.Number),
  reasoningEffort: Schema.optionalKey(Schema.Literals(["none", "minimal", "low", "medium", "high", "xhigh"]))
})

const requestSchema = Schema.Struct({
  modelId: Schema.String,
  system: Schema.Array(textPartSchema),
  messages: Schema.Array(messageSchema),
  tools: Schema.Array(toolSchema),
  params: paramsSchema,
  toolChoice: Schema.optionalKey(Schema.Literal("none"))
})

// The codes are exactly `/model/ModelError`'s `ModelErrorCode`. Permission and
// grant-store codes are `/capability/Permission`'s, and the model package never
// emits one as a provider failure.
const failureSchema = Schema.Struct({
  code: Schema.Literals([
    "invalid_request",
    "context_overflow",
    "no_route",
    "authentication",
    "rate_limited",
    "quota_exceeded",
    "content_policy",
    "provider_internal",
    "transport",
    "call_timeout",
    "invalid_provider_output",
    "unknown"
  ]),
  message: Schema.String,
  retryAfterMillis: Schema.optionalKey(Schema.Number),
  resetAtEpochMillis: Schema.optionalKey(Schema.Number),
  resetSource: Schema.optionalKey(Schema.String),
  providerCode: Schema.optionalKey(Schema.String),
  requestId: Schema.optionalKey(Schema.String),
  httpStatus: Schema.optionalKey(Schema.Number)
})

const recordedCallSchema = Schema.Struct({
  request: requestSchema,
  model: Schema.String,
  events: Schema.Array(eventSchema),
  failure: Schema.optionalKey(failureSchema)
})

/**
 * The JSON schema for a recorded-model fixture. The nested request, message,
 * tool, and params shapes mirror `/model/ModelRequest` structurally (the
 * provider-neutral types are owned by `ModelLike`), so an invalid fixture
 * fails decoding.
 *
 * @category schemas
 * @since 0.0.0
 */
export const Fixture = Schema.Struct({ calls: Schema.Array(recordedCallSchema) })

/**
 * Decodes a checked-in recorded-model fixture.
 *
 * @category decoders
 * @since 0.0.0
 */
export const decode = (input: unknown): Effect.Effect<Fixture, Schema.SchemaError> =>
  Schema.decodeUnknownEffect(Fixture)(input)

const invalid = (path: string): never => {
  throw new TypeError(`Value at ${path} is not valid JSON`)
}

/**
 * Re-derived locally from `/model`'s `CanonicalJson.stringify` algorithm:
 * object keys sort recursively, array order is retained, and non-JSON values
 * are rejected. Keeping the algorithm here avoids a production-model runtime
 * dependency while preserving the recorded-model request identity contract.
 *
 * @category encoding
 * @since 0.0.0
 */
export const canonicalRequestDigest = (request: ModelRequestLike): string =>
  JSON.stringify(canonicalize(recordedRequest(request)))

const optional = <K extends string, A>(key: K, value: A | undefined): { readonly [P in K]?: A } =>
  value === undefined ? {} : { [key]: value } as { readonly [P in K]?: A }

/**
 * Projects a request onto the plain JSON data a fixture stores.
 *
 * The production `ModelRequest` is a `Schema.Class` whose messages, tools, and
 * params are class instances. A recorder that stored one verbatim would write a
 * fixture whose shape depends on the class, and {@link canonicalRequestDigest}
 * rejects any value that is not a plain object. This copy keeps the recorded
 * request, the decoded fixture, and the digest input the same value.
 *
 * @category encoding
 * @since 0.0.0
 */
export const recordedRequest = (request: ModelRequestLike): ModelRequestLike => ({
  modelId: request.modelId,
  system: request.system.map((part) => ({ type: part.type, text: part.text })),
  messages: request.messages.map((message) => {
    switch (message.role) {
      case "user":
        return {
          role: message.role,
          content: message.content.map((part) => ({ type: part.type, text: part.text }))
        }
      case "assistant":
        return {
          role: message.role,
          content: message.content.map((part) => {
            switch (part.type) {
              case "text":
                return { type: part.type, text: part.text }
              case "thinking":
                return { type: part.type, text: part.text, ...optional("signature", part.signature) }
              case "tool-call":
                return {
                  type: part.type,
                  id: part.id,
                  name: part.name,
                  arguments: part.arguments
                }
            }
          }),
          stopReason: message.stopReason,
          ...optional("responseId", message.responseId),
          ...optional("itemIds", message.itemIds)
        }
      case "tool":
        return {
          role: message.role,
          content: message.content.map((part) => ({
            type: part.type,
            toolCallId: part.toolCallId,
            content: part.content,
            addedToolNames: [...part.addedToolNames]
          }))
        }
    }
  }),
  tools: request.tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    ...optional("deferred", tool.deferred),
    ...optional("loader", tool.loader)
  })),
  params: {
    ...optional("maxTokens", request.params.maxTokens),
    ...optional("temperature", request.params.temperature),
    ...optional("topP", request.params.topP),
    ...optional("topK", request.params.topK),
    ...optional("stopSequences", request.params.stopSequences),
    ...optional("thinkingBudget", request.params.thinkingBudget),
    ...optional("reasoningEffort", request.params.reasoningEffort)
  },
  ...optional("toolChoice", request.toolChoice)
})

const canonicalize = (value: unknown, path = "$", ancestors = new Set<object>()): unknown => {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value
  if (typeof value === "number") return Number.isFinite(value) ? value : invalid(path)
  if (Array.isArray(value)) {
    if (ancestors.has(value)) return invalid(path)
    ancestors.add(value)
    const result = value.map((item, index) => canonicalize(item, `${path}[${index}]`, ancestors))
    ancestors.delete(value)
    return result
  }
  if (typeof value === "object" && value !== null) {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return invalid(path)
    if (ancestors.has(value) || Object.getOwnPropertySymbols(value).length > 0) return invalid(path)
    ancestors.add(value)
    const result: Record<string, unknown> = {}
    for (const key of Object.keys(value).sort()) {
      result[key] = canonicalize((value as Record<string, unknown>)[key], `${path}.${key}`, ancestors)
    }
    ancestors.delete(value)
    return result
  }
  return invalid(path)
}
