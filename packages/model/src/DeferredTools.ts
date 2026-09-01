/**
 * Replay-safe policy for native deferred provider tool loading.
 *
 * @since 0.1.0
 */
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

/**
 * Anthropic support is a VERSION FLOOR, not an allowlist: every
 * `claude-{sonnet,opus,fable}` id at 4.5 or later reports native support,
 * including families that do not exist yet. Anthropic versions its Messages
 * capabilities by family generation and has added deferred tools to every
 * generation since 4.5, so a floor is forward-compatible and a new model works
 * on the day it ships. A model below the floor, a dated pre-4.5 id, and haiku
 * are all false.
 *
 * OpenAI support is an ALLOWLIST ({@link OPENAI_DEFERRED_MODELS}): its ids do
 * not carry a comparable capability version, so a new family stays opt-in until
 * its wire support has been verified against the live backend.
 *
 * The two policies are deliberately different. Neither is "the exact matrix".
 */
const isAnthropicDeferredModel = (modelId: string): boolean => {
  const match = /^claude-(sonnet|opus|fable)-(\d+)(?:[-.](\d+))?(?:-|$)/i.exec(modelId)
  if (match === null) return false
  // Dated ids such as `claude-sonnet-4-20250514` designate the pre-4.5
  // family, rather than a fictional 4.20250514 capability version.
  const major = Number(match[2])
  const minor = match[3] === undefined || match[3].length >= 8 ? 0 : Number(match[3])
  return major > 4 || (major === 4 && minor >= 5)
}

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

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

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

// docs/specs/Research/Pi Reference Findings 2026-07-27.md §4:
// lazy schemas must not change the prompt prefix.
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
 * The two providers follow different policies on purpose. Anthropic is a
 * version floor: any `claude-{sonnet,opus,fable}` id at 4.5 or later answers
 * true, including families released after this code, because Anthropic versions
 * the capability by family generation. OpenAI is an allowlist: its ids carry no
 * comparable version, so a new family answers false until its wire support has
 * been verified against the live backend and added here.
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
