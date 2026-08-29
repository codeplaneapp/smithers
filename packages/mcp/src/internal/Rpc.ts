/**
 * JSON-RPC 2.0 envelope encoding for the MCP stdio transport.
 *
 * MCP's stdio transport frames every message as exactly one line of JSON on
 * standard input or output, so this module is pure line-shaped codec: no
 * process, no scheduling, no retry policy. {@link StdioTransport} owns those.
 *
 * @since 0.1.0
 */

/**
 * A JSON-RPC call this client sends. Omitting `id` sends a notification, for
 * which the server never replies.
 *
 * @category models
 * @since 0.1.0
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
 * @since 0.1.0
 */
export interface Inbound {
  readonly jsonrpc: "2.0"
  readonly id?: number | undefined
  readonly method?: string | undefined
  readonly params?: unknown
  readonly result?: unknown
  readonly error?: { readonly code: number; readonly message: string; readonly data?: unknown } | undefined
}

const encoder = new TextEncoder()

/**
 * Encodes one outbound message as a newline-terminated UTF-8 frame.
 *
 * @category conversions
 * @since 0.1.0
 */
export const encode = (message: Outbound): Uint8Array => encoder.encode(`${JSON.stringify(message)}\n`)

/**
 * Parses one line of server output. A blank line, a line that is not JSON, or
 * a JSON value that is not a `"2.0"`-tagged object is not a protocol error —
 * `undefined` means "nothing to correlate", and the caller drops it.
 *
 * @category conversions
 * @since 0.1.0
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
 * notification): it carries a numeric `id` and no `method`.
 *
 * @category guards
 * @since 0.1.0
 */
export const isReply = (message: Inbound): message is Inbound & { readonly id: number } =>
  typeof message.id === "number" && message.method === undefined
