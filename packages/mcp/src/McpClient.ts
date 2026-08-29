/**
 * A minimal MCP client: the `initialize` handshake, `tools/list`, and
 * `tools/call`, over {@link StdioTransport}.
 *
 * This is deliberately not a general MCP SDK. `flows` has exactly one
 * consumer of an MCP session — {@link McpFlows}, which needs a tool catalog
 * and a way to invoke one entry from it — so the client exposes only that.
 * Resources, prompts, sampling, and roots are not wired up; add them here
 * when a flow adapter needs them, not speculatively.
 *
 * @since 0.1.0
 */
import { Effect, Result } from "effect"
import type { Scope } from "effect"
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import * as StdioTransport from "./internal/StdioTransport.ts"
import { McpError } from "./McpError.ts"

/**
 * One remote tool as the server describes it.
 *
 * @category models
 * @since 0.1.0
 */
export interface ToolDescription {
  readonly name: string
  readonly description: string | undefined
  /** The tool's parameter shape, as the server's own JSON Schema document. */
  readonly inputSchema: unknown
}

/**
 * The result of one `tools/call`.
 *
 * MCP tool content is a small union (text, image, embedded resource, …); this
 * client passes every block through by shape rather than modeling the union,
 * since {@link McpFlows} only needs to hand the blocks back to the caller.
 *
 * @category models
 * @since 0.1.0
 */
export interface ToolResult {
  readonly content: ReadonlyArray<Record<string, unknown>>
  readonly isError: boolean
}

/**
 * A live MCP session: the tool catalog fetched at connect time, and a way to
 * call one of its entries.
 *
 * @category models
 * @since 0.1.0
 */
export interface McpClient {
  readonly server: string
  readonly tools: ReadonlyArray<ToolDescription>
  readonly callTool: (name: string, args: Record<string, unknown>) => Effect.Effect<ToolResult, McpError>
}

/**
 * Options accepted by {@link connect}.
 *
 * @category models
 * @since 0.1.0
 */
export interface ConnectOptions {
  /** The name this server is known by, for flow naming and error messages. */
  readonly server: string
  readonly command: string
  readonly args: ReadonlyArray<string>
  readonly cwd?: string | undefined
  readonly env?: Record<string, string | undefined> | undefined
}

const CLIENT_INFO = { name: "flows", version: "0.1.0" }
const PROTOCOL_VERSION = "2025-06-18"

const invalidResponse = (server: string, message: string): McpError =>
  new McpError({ code: "invalid_response", message, server })

/**
 * Decodes a `tools/list` result into descriptions, or the one reason the
 * catalog cannot be used. A malformed tool entry fails the whole list rather
 * than silently dropping one: a source that discloses a partial catalog gives
 * the caller no way to tell "the server has three tools" from "two failed to
 * parse", so {@link McpFlows} reports connection failure and offers nothing
 * instead.
 */
const asToolList = (
  server: string,
  result: unknown
): Result.Result<ReadonlyArray<ToolDescription>, McpError> => {
  const tools = (result as { readonly tools?: unknown } | null)?.tools
  if (!Array.isArray(tools)) {
    return Result.fail(invalidResponse(server, "tools/list did not return a tools array"))
  }
  const described: Array<ToolDescription> = []
  for (const tool of tools) {
    const record = tool as {
      readonly name?: unknown
      readonly description?: unknown
      readonly inputSchema?: unknown
    }
    if (typeof record.name !== "string" || record.name === "") {
      return Result.fail(invalidResponse(server, "tools/list returned a tool with no name"))
    }
    described.push({
      name: record.name,
      description: typeof record.description === "string" ? record.description : undefined,
      inputSchema: record.inputSchema ?? { type: "object" }
    })
  }
  return Result.succeed(described)
}

/** A malformed `tools/call` result degrades to empty content rather than failing the call: the remote tool ran. */
const asToolResult = (result: unknown): ToolResult => {
  const record = result as { readonly content?: unknown; readonly isError?: unknown } | null
  const content = Array.isArray(record?.content) ? record.content as ReadonlyArray<Record<string, unknown>> : []
  return { content, isError: record?.isError === true }
}

/**
 * Connects to an MCP server over stdio, completes the `initialize` handshake,
 * and fetches its tool catalog once, up front.
 *
 * The tool catalog is a snapshot: a server that changes its tools after
 * connecting (a `notifications/tools/list_changed` push) is not re-polled.
 * {@link McpFlows} rebuilds by reconnecting, the same shape
 * `ctx.<domain>.reload()` gives every other transform source in this repo.
 *
 * @category constructors
 * @since 0.1.0
 */
export const connect = (
  options: ConnectOptions
): Effect.Effect<McpClient, McpError, ChildProcessSpawner | Scope.Scope> =>
  Effect.gen(function*() {
    const transport = yield* StdioTransport.connect(options)

    yield* transport.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: CLIENT_INFO
    })
    // A notification, not a request: the server never replies to it, and the
    // handshake is not complete until the client sends it.
    yield* transport.notify("notifications/initialized")

    const listed = yield* transport.request("tools/list", {})
    const tools = yield* Effect.fromResult(asToolList(options.server, listed))

    const callTool = (name: string, args: Record<string, unknown>): Effect.Effect<ToolResult, McpError> =>
      Effect.map(transport.request("tools/call", { name, arguments: args }), asToolResult)

    return { server: options.server, tools, callTool }
  })
