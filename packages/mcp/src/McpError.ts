/**
 * The single typed error returned by the MCP client and flow adapter.
 *
 * @since 0.1.0
 */
import { Schema } from "effect"

/**
 * Stable, model-facing failure codes for MCP operations.
 *
 * @category models
 * @since 0.1.0
 */
export const Code = Schema.Literals([
  "spawn_failed",
  "connection_closed",
  "protocol_error",
  "tool_not_found",
  "tool_failed",
  "invalid_response"
])

/**
 * Stable, model-facing failure codes for MCP operations.
 *
 * @category models
 * @since 0.1.0
 */
export type Code = typeof Code.Type

/**
 * A recoverable MCP client or flow-adapter failure.
 *
 * Handlers keep ordinary tool outcomes (the remote tool's own `isError`
 * result) in the success channel; this error is reserved for failures of the
 * MCP session itself — the server would not exist, the pipe closed, a
 * response could not be parsed.
 *
 * @category errors
 * @since 0.1.0
 */
export class McpError extends Schema.TaggedError<McpError>()("flows/mcp/McpError", {
  code: Code,
  message: Schema.String,
  server: Schema.optional(Schema.String)
}) {}
