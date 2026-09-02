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
 * A JSON-RPC message the server sends back: a reply to one of our requests
 * (carries `id`, and either `result` or `error`) or a server-initiated
 * notification (carries `method`, never `id`).
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface Inbound {
  readonly jsonrpc: "2.0"
  readonly id?: number | string | undefined
  readonly method?: string | undefined
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

const encoder = new TextEncoder()

/**
 * Encodes one outbound message as a newline-terminated UTF-8 frame.
 *
 * @category conversions
 * @since 1.0.0-rc.0
 */
export const encode = (message: Outbound): Uint8Array => encoder.encode(`${JSON.stringify(message)}\n`)

/**
 * Parses one line of server output. A blank line, a line that is not JSON, or
 * a JSON value that is not a `"2.0"`-tagged object is not a protocol error —
 * `undefined` means "nothing to correlate", and the caller drops it.
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
  if (typeof value !== "object" || value === null) return undefined
  if ((value as { readonly jsonrpc?: unknown }).jsonrpc !== "2.0") return undefined
  return value as Inbound
}

/**
 * Whether an inbound message is a reply (as opposed to a server-initiated
 * notification): it carries a numeric or string `id` and no `method`.
 *
 * @category guards
 * @since 1.0.0-rc.0
 */
export const isReply = (message: Inbound): message is Inbound & { readonly id: number | string } =>
  (typeof message.id === "number" || typeof message.id === "string") && message.method === undefined

const malformed = (reason: string): Reply => ({ _tag: "Malformed", reason })

/**
 * Validates and normalizes a parsed inbound reply.
 *
 * Digit-string ids are accepted only in their canonical ASCII decimal form,
 * then converted back to the safe integer id used by the pending-request map.
 * Exactly one own `result` or `error` property must be present.
 *
 * @category conversions
 * @since 1.0.0-rc.0
 */
export const replyOf = (message: Inbound & { readonly id: number | string }): Reply => {
  const id = typeof message.id === "number"
    ? message.id
    : /^(0|[1-9][0-9]*)$/.test(message.id)
    ? Number(message.id)
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
