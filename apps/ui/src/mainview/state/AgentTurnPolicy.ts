import type { AgentChatMessage, StartAgentTurnRequest } from "smithers-shared/NativeAgent"
import type { Message } from "./AppState"

/** The deployed Worker rejects request bodies above 64 KiB. Leave framing headroom. */
export const MAX_TURN_REQUEST_BYTES = 60 * 1024
/** Keep roughly Pi's recent-context policy, adjusted for this boundary's smaller envelope. */
export const KEEP_RECENT_CONTEXT_TOKENS = 8_000
/** A single tool result must not consume most of the next request. */
export const MAX_TOOL_RESULT_BYTES = 16 * 1024
export const MAX_TOOL_RESULT_LINES = 1_000

const encoder = new TextEncoder()

export const utf8Bytes = (text: string): number => encoder.encode(text).byteLength

/** Pi's intentionally cheap, conservative-enough approximation for text-only messages. */
export const estimateTextTokens = (text: string): number => Math.ceil(text.length / 4)

export const turnRequestBytes = (request: StartAgentTurnRequest): number => utf8Bytes(JSON.stringify(request))

export interface ContextCompaction {
  readonly summary: string
  readonly throughOrdinal: number
  readonly sourceMessageCount: number
  readonly createdAt: number
}

const COMPACTION_PREFIX =
  "The conversation history before this point was compacted into the following summary:\n\n<summary>\n"
const COMPACTION_SUFFIX = "\n</summary>"

export const contextMessages = (
  messages: ReadonlyArray<Message>,
  compaction?: ContextCompaction | null
): ReadonlyArray<AgentChatMessage> => {
  const visible = messages
    .filter(
      (message) =>
        message.act === undefined &&
        message.text.trim() !== "" &&
        (compaction === undefined || compaction === null || message.ordinal > compaction.throughOrdinal)
    )
    .map((message) => ({
      role: message.role === "user" ? ("user" as const) : ("assistant" as const),
      content: message.text
    }))
  if (compaction === undefined || compaction === null) return visible
  return [
    { role: "user", content: `${COMPACTION_PREFIX}${compaction.summary}${COMPACTION_SUFFIX}` },
    ...visible
  ]
}

export interface CompactionSlice {
  /** Complete older messages to summarize. */
  readonly compact: ReadonlyArray<Message>
  /** Complete recent messages retained verbatim. */
  readonly keep: ReadonlyArray<Message>
  readonly throughOrdinal: number
}

/**
 * Choose a Pi-style cut point by walking backward over complete messages, then
 * move the cut to a user-message boundary so an assistant answer is never kept
 * without the prompt that caused it.
 */
export const selectCompactionSlice = (
  messages: ReadonlyArray<Message>,
  keepRecentTokens = KEEP_RECENT_CONTEXT_TOKENS
): CompactionSlice | undefined => {
  const eligible = messages.filter((message) => message.act === undefined && message.text.trim() !== "")
  if (eligible.length < 3) return undefined
  let tokens = 0
  let keepIndex = eligible.length - 1
  for (let index = eligible.length - 1; index >= 0; index -= 1) {
    tokens += estimateTextTokens(eligible[index]?.text ?? "")
    keepIndex = index
    if (tokens >= keepRecentTokens) break
  }
  while (keepIndex > 0 && eligible[keepIndex]?.role !== "user") keepIndex -= 1
  if (keepIndex <= 0) return undefined
  const compact = eligible.slice(0, keepIndex)
  const keep = eligible.slice(keepIndex)
  const throughOrdinal = compact.at(-1)?.ordinal
  return throughOrdinal === undefined ? undefined : { compact, keep, throughOrdinal }
}

const byteSafePrefix = (text: string, maxBytes: number): string => {
  if (maxBytes <= 0) return ""
  const bytes = encoder.encode(text)
  if (bytes.byteLength <= maxBytes) return text
  return new TextDecoder().decode(bytes.slice(0, maxBytes))
}

export interface BoundedToolResult {
  readonly modelOutput: string
  readonly truncated: boolean
  readonly totalBytes: number
  readonly totalLines: number
}

/**
 * Bound opaque tool output by both lines and UTF-8 bytes. Keep the head because
 * command results put their status/discriminator first, and append an explicit
 * marker so the model can never mistake partial evidence for the full result.
 */
export const boundToolResult = (
  result: string,
  maxBytes = MAX_TOOL_RESULT_BYTES,
  maxLines = MAX_TOOL_RESULT_LINES
): BoundedToolResult => {
  const totalBytes = utf8Bytes(result)
  const lines = result.split("\n")
  const totalLines = lines.length
  if (totalBytes <= maxBytes && totalLines <= maxLines) {
    return { modelOutput: result, truncated: false, totalBytes, totalLines }
  }
  const marker = `\n\n[Tool result truncated: ${totalBytes} bytes, ${totalLines} lines total.]`
  const contentBudget = Math.max(0, maxBytes - utf8Bytes(marker))
  const lineLimited = lines.slice(0, maxLines).join("\n")
  const prefix = byteSafePrefix(lineLimited, contentBudget).replace(/\uFFFD$/u, "")
  return {
    modelOutput: `${prefix}${marker}`,
    truncated: true,
    totalBytes,
    totalLines
  }
}

/**
 * The line that stands where dropped history was.
 *
 * Never silent: a model that is missing the start of a conversation must know
 * it is missing it, or it will answer confidently about words it never saw.
 */
export const droppedHistoryNotice = (dropped: number): string =>
  `[${dropped} earlier message${dropped === 1 ? "" : "s"} in this conversation ${
    dropped === 1 ? "was" : "were"
  } dropped to fit this turn's size limit. If the user refers to something from before, say you may no longer have it rather than guessing.]`

export interface BoundedTurnRequest {
  readonly request: StartAgentTurnRequest
  /** How many messages were dropped from the head, zero when the turn already fit. */
  readonly dropped: number
}

/**
 * Bound one turn request to the boundary's body limit (§4.13).
 *
 * The client re-sent the whole transcript on every turn, so seven long answers
 * pushed `POST /api/agent/turn` past the upstream body limit and the
 * conversation was then permanently dead: every later turn failed the same
 * way, and `/clear` could not recover it because `/clear` runs a model turn of
 * its own and hit the same wall. The only escape was clearing the origin's
 * storage from outside the app.
 *
 * So the oldest messages are dropped until the request fits, and a notice
 * takes their place. `keepTail` is the count of trailing messages that must
 * survive — the user's own prompt, and the function_call/function_call_output
 * pairs of a tool leg, which are meaningless split apart.
 */
export const boundTurnRequest = (
  request: StartAgentTurnRequest,
  keepTail = 1,
  maxBytes = MAX_TURN_REQUEST_BYTES
): BoundedTurnRequest => {
  if (turnRequestBytes(request) <= maxBytes) return { request, dropped: 0 }
  const messages = [...request.messages]
  const floor = Math.min(Math.max(keepTail, 1), messages.length)
  let dropped = 0
  let candidate = request
  while (messages.length > floor) {
    messages.shift()
    dropped += 1
    candidate = {
      ...request,
      messages: [{ role: "user", content: droppedHistoryNotice(dropped) }, ...messages]
    }
    if (turnRequestBytes(candidate) <= maxBytes) return { request: candidate, dropped }
  }
  // Even the tail alone is over the limit: the seam refuses it honestly, and
  // dropping the user's own words to hide that would be the worse answer.
  return { request: candidate, dropped }
}
