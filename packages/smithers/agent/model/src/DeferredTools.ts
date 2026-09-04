/**
 * Replay-safe policy for native deferred provider tool loading.
 *
 * @since 0.1.0
 */
import { isRecord } from "@smthrs/canonical/Record"
import type { ModelRequest, ToolDefinition } from "./ModelRequest.ts"

/**
 * Provider protocol ids with a native deferred-tool representation.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type ProtocolId = "anthropic-messages" | "openai-responses"

/**
 * The immediate and lazy tool definitions derived from a sealed request.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface Resolution {
  readonly immediate: ReadonlyArray<ToolDefinition>
  readonly deferred: ReadonlyArray<ToolDefinition>
  readonly activatedNames: ReadonlyArray<string>
}

const normalizedName = (name: string): string => name.trim().toLowerCase()

// Both providers are allowlists. Native deferral changes the wire body, so a
// model answers true only once its support is documented or verified against
// the live backend. Every other id, including a family or version released
// after this code, lowers through the portable non-native path until somebody
// adds it here: a version comparison would enable unverified wire behavior
// without a release, which is the one thing this predicate must never do.
//
// The Anthropic list mirrors the model compatibility table on
// https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool
// (fetched 2026-09-01) plus the undated alias of each dated 4.5 id, which
// Anthropic serves for the same model. Sonnet 5 is absent from that table, so
// it is absent here; Opus 4.1 and earlier do not support the feature.
const ANTHROPIC_DEFERRED_MODELS = new Set([
  "claude-fable-5-1",
  "claude-mythos-5-1",
  "claude-fable-5",
  "claude-mythos-5",
  "claude-opus-5",
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-opus-4-6",
  "claude-sonnet-4-6",
  "claude-opus-4-5",
  "claude-opus-4-5-20251101",
  "claude-sonnet-4-5",
  "claude-sonnet-4-5-20250929",
  "claude-haiku-4-5",
  "claude-haiku-4-5-20251001"
])

const isAnthropicDeferredModel = (modelId: string): boolean => ANTHROPIC_DEFERRED_MODELS.has(modelId.toLowerCase())

// Seeded from pi's generated model compatibility metadata. New families remain
// opt-in until their wire support is verified against the live backend.
const OPENAI_DEFERRED_MODELS = new Set([
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.4-pro",
  "gpt-5.5",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna"
])

const isOpenAiDeferredModel = (modelId: string): boolean => OPENAI_DEFERRED_MODELS.has(modelId.toLowerCase())

const toolCallNames = (value: unknown): ReadonlyArray<string> => {
  const names: Array<string> = []
  const visit = (current: unknown): void => {
    if (Array.isArray(current)) {
      for (const entry of current) visit(entry)
      return
    }
    if (!isRecord(current)) return
    const tag = typeof current["_tag"] === "string" ? current["_tag"] : current["type"]
    if (typeof tag === "string" && tag.toLowerCase().replaceAll("-", "").includes("toolcall")) {
      const name = current["name"]
      if (typeof name === "string") names.push(name)
    }
    for (const child of Object.values(current)) visit(child)
  }
  visit(value)
  return names
}

const addedToolNames = (value: unknown): ReadonlyArray<string> => {
  const names: Array<string> = []
  const visit = (current: unknown): void => {
    if (Array.isArray(current)) {
      for (const entry of current) visit(entry)
      return
    }
    if (!isRecord(current)) return
    const added = current["addedToolNames"]
    if (Array.isArray(added)) {
      for (const name of added) if (typeof name === "string") names.push(name)
    }
    for (const child of Object.values(current)) visit(child)
  }
  visit(value)
  return names
}

const uniqueTools = (tools: ReadonlyArray<ToolDefinition>): ReadonlyArray<ToolDefinition> => {
  const seen = new Set<string>()
  const result: Array<ToolDefinition> = []
  for (const tool of tools) {
    const name = normalizedName(tool.name)
    if (name === "" || seen.has(name)) continue
    seen.add(name)
    result.push(tool)
  }
  return result
}

// Measured against pi's reference implementation: a lazy schema must not
// change the prompt prefix.
const lazyTool = (tool: ToolDefinition): ToolDefinition => ({
  name: tool.name,
  description: tool.description,
  parameters: tool.parameters,
  deferred: tool.deferred,
  loader: tool.loader
})

/**
 * Reports whether a protocol and model pair supports pi's native deferred
 * tool-loading wire representation.
 *
 * Both providers answer from an explicit allowlist, matched case-insensitively.
 * An id absent from its provider's list answers false, including a family or
 * version released after this code, because native deferral changes the wire
 * body and an unverified body must not be enabled without a release. Such a
 * model still receives every tool through the portable non-native lowering.
 *
 * @category predicates
 * @since 0.1.0
 * @slop
 */
export const supportsDeferred = (protocolId: ProtocolId, modelId: string): boolean =>
  protocolId === "anthropic-messages"
    ? isAnthropicDeferredModel(modelId)
    : isOpenAiDeferredModel(modelId)

/**
 * Resolves immediate and deferred tools from declared `deferred` annotations
 * and the chronological transcript only. Unsupported models receive
 * non-deferred definitions plus additively activated lazy definitions. No
 * process-local activation state is consulted, so replay produces the
 * identical tool partition.
 *
 * @category operations
 * @since 0.1.0
 * @slop
 */
export const resolve = (request: ModelRequest, native: boolean): Resolution => {
  const tools = uniqueTools(request.tools)
  const known = new Map(tools.map((tool) => [normalizedName(tool.name), tool] as const))
  const used = new Set<string>()
  const usedBeforeActivation = new Set<string>()
  const activated = new Set<string>()
  for (const message of request.messages) {
    for (const name of toolCallNames(message)) used.add(normalizedName(name))
    for (const name of addedToolNames(message)) {
      const normalized = normalizedName(name)
      if (known.has(normalized)) {
        if (!activated.has(normalized) && used.has(normalized)) usedBeforeActivation.add(normalized)
        activated.add(normalized)
      }
    }
  }

  if (!native) {
    return {
      immediate: tools.filter((tool) => {
        const name = normalizedName(tool.name)
        return tool.deferred !== true || activated.has(name) || usedBeforeActivation.has(name)
      }),
      deferred: [],
      activatedNames: tools.filter((tool) => activated.has(normalizedName(tool.name))).map((tool) => tool.name)
    }
  }

  const immediate: Array<ToolDefinition> = []
  const deferred: Array<ToolDefinition> = []
  for (const tool of tools) {
    const name = normalizedName(tool.name)
    const lazy = tool.deferred === true || activated.has(name)
    if (tool.loader === true || !lazy || usedBeforeActivation.has(name)) {
      immediate.push(tool)
    } else {
      deferred.push(lazyTool(tool))
    }
  }
  if (immediate.length === 0) {
    return { immediate: deferred, deferred: [], activatedNames: [] }
  }
  return {
    immediate,
    deferred,
    activatedNames: tools.filter((tool) => activated.has(normalizedName(tool.name))).map((tool) => tool.name)
  }
}
