/**
 * JSON-RPC 2.0 envelope encoding for the MCP stdio transport.
 *
 * MCP's stdio transport frames every message as exactly one line of JSON on
 * standard input or output, so this module is pure line-shaped codec: no
 * process, no scheduling, no retry policy. {@link StdioTransport} owns those.
 *
 * @since 1.0.0-rc.0
 */

/**
 * A JSON-RPC call this client sends. Omitting `id` sends a notification, for
 * which the server never replies.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface Outbound {
  readonly jsonrpc: "2.0"
  readonly id?: number | undefined
  readonly method: string
  readonly params?: unknown
}

/**
 * A JSON object from server stdout that claims JSON-RPC by carrying its own
 * `jsonrpc` property. Validation happens after parsing so an incorrect version
 * cannot be mistaken for ordinary stdout noise.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface Inbound {
  readonly jsonrpc: unknown
  readonly id?: unknown
  readonly method?: unknown
  readonly params?: unknown
  readonly result?: unknown
  readonly error?: unknown
}

/**
 * A validated JSON-RPC reply, normalized to the numeric request id this
 * client uses for correlation.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type Reply = {
  readonly _tag: "Result"
  readonly id: number
  readonly result: unknown
} | {
  readonly _tag: "Error"
  readonly id: number
  readonly code: number
  readonly message: string
  readonly data: unknown
} | {
  readonly _tag: "Malformed"
  readonly reason: string
}

/**
 * The transport-relevant classification of one parsed JSON-RPC object.
 * Notifications need no correlation; every other tagged object is either a
 * validated reply or a malformed envelope that must close the connection.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type Classification = { readonly _tag: "Notification" } | Reply

const encoder = new TextEncoder()

/**
 * Encodes one outbound message as a newline-terminated UTF-8 frame.
 *
 * @category conversions
 * @since 1.0.0-rc.0
 */
export const encode = (message: Outbound): Uint8Array => encoder.encode(`${JSON.stringify(message)}\n`)

/**
 * Parses one line of server output. A blank line, invalid JSON, a non-object,
 * or an object with no own `jsonrpc` property returns `undefined`. MCP servers
 * commonly log to stdout, so output that does not claim to be JSON-RPC is
 * noise rather than a protocol violation. Tagged objects are preserved for
 * {@link classify}, including objects that claim the wrong version.
 *
 * @category conversions
 * @since 1.0.0-rc.0
 */
export const parse = (line: string): Inbound | undefined => {
  const trimmed = line.trim()
  if (trimmed === "") return undefined
  let value: unknown
  try {
    value = JSON.parse(trimmed)
  } catch {
    return undefined
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  if (!Object.hasOwn(value, "jsonrpc")) return undefined
  return value as Inbound
}

const malformed = (reason: string): Reply => ({ _tag: "Malformed", reason })

/**
 * Validates and normalizes a parsed inbound object as a reply.
 *
 * Digit-string ids are accepted only in their canonical ASCII decimal form,
 * then converted back to the safe integer id used by the pending-request map.
 * A reply must carry an own id and exactly one own `result` or `error`
 * property.
 *
 * @category conversions
 * @since 1.0.0-rc.0
 */
export const replyOf = (message: Inbound): Reply => {
  if (!Object.hasOwn(message, "id")) return malformed("a reply carried no id")
  const rawId = message.id
  const id = typeof rawId === "number"
    ? rawId
    : typeof rawId === "string" && /^(0|[1-9][0-9]*)$/.test(rawId)
    ? Number(rawId)
    : Number.NaN
  if (!Number.isSafeInteger(id)) return malformed("a reply id must be a JSON-RPC integer")

  const hasResult = Object.hasOwn(message, "result")
  const hasError = Object.hasOwn(message, "error")
  if (!hasResult && !hasError) return malformed("a reply carried neither result nor error")
  if (hasResult && hasError) return malformed("a reply carried both result and error")
  if (hasResult) return { _tag: "Result", id, result: message.result }

  const error = message.error
  if (
    typeof error !== "object" || error === null || Array.isArray(error) ||
    !Number.isInteger((error as { readonly code?: unknown }).code) ||
    typeof (error as { readonly message?: unknown }).message !== "string"
  ) {
    return malformed("a reply carried a malformed error object")
  }
  const record = error as { readonly code: number; readonly message: string; readonly data?: unknown }
  return {
    _tag: "Error",
    id,
    code: record.code,
    message: record.message,
    data: record.data
  }
}

/**
 * Classifies a parsed JSON-RPC object for the stdio reader. A wrong version is
 * malformed, an own `method` property marks a server notification, and every
 * remaining object must satisfy {@link replyOf}.
 *
 * @category conversions
 * @since 1.0.0-rc.0
 */
export const classify = (message: Inbound): Classification => {
  if (message.jsonrpc !== "2.0") {
    return malformed("a JSON-RPC message must carry jsonrpc \"2.0\"")
  }
  if (Object.hasOwn(message, "method")) return { _tag: "Notification" }
  return replyOf(message)
}
