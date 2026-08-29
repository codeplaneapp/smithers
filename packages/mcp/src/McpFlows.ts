/**
 * Projects a connected MCP server's tools as an ordinary {@link FlowBinding.Source}.
 *
 * This is the whole adapter: `@smthrs/harness/FlowBinding`'s own module doc
 * already names the target directly — "a standard filesystem flow, a memory
 * flow, an incoming MCP tool, a durable child agent" are all just a flow
 * declaration plus the code that runs it. Nothing about the harness, the
 * registry, or the cell loop needs to know a given flow's implementation
 * happens to proxy a remote MCP `tools/call`; a cell that reads a file and a
 * cell that calls an MCP tool run the identical two lines.
 *
 * @since 0.1.0
 */
import * as Effects from "@smthrs/core/Effects"
import * as FlowBinding from "@smthrs/harness/FlowBinding"
import { Effect, Schema } from "effect"
import type { Scope } from "effect"
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import * as McpClient from "./McpClient.ts"
import type { McpError } from "./McpError.ts"

/**
 * Decoded input accepted by every MCP tool flow: whatever the remote tool's
 * own JSON Schema describes. The registry still discloses the real parameter
 * shape — see {@link toolBinding} — this is only the runtime decode, and it
 * is permissive because the server, not this adapter, owns validation.
 *
 * @category schemas
 * @since 0.1.0
 */
const Args = Schema.Record(Schema.String, Schema.Unknown)

/**
 * Decoded output returned by every MCP tool flow: the tool's content blocks,
 * passed through by shape, and whether the server reported an error.
 *
 * @category schemas
 * @since 0.1.0
 */
const Result = Schema.Struct({
  content: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
  isError: Schema.Boolean
})

/**
 * The conservative effect envelope every MCP tool flow declares.
 *
 * An MCP tool is opaque code this adapter does not control, the same
 * situation `@smthrs/registry/MarkdownFlow` calls "unprojectable authority"
 * for a skill with no declared `capabilities`: the honest declaration is the
 * wildcard, not a guess.
 *
 * @category effects
 * @since 0.1.0
 */
const effects = Effects.make({
  reads: ["**"],
  writes: ["**"],
  mode: "expected",
  onConflict: "serialize",
  tier: "irreversible"
})

/** One remote tool, bound to a flow name scoped by server so two servers may reuse a tool name. */
const toolBinding = (client: McpClient.McpClient, tool: McpClient.ToolDescription): FlowBinding.Binding =>
  FlowBinding.make({
    flow: {
      name: `mcp/${client.server}/${tool.name}`,
      description: tool.description ?? `MCP tool "${tool.name}" on server "${client.server}"`,
      capabilities: ["*"],
      effects,
      input: Args,
      output: Result
    },
    // The server's own JSON Schema document, carried by value so a caller
    // reading `ctx.flows` sees the real parameter shape rather than `Args`'s
    // permissive record type.
    inputDocument: (tool.inputSchema ?? { type: "object" }) as Schema.Json,
    handler: (input): Effect.Effect<typeof Result.Type, McpError> =>
      Effect.map(client.callTool(tool.name, input), (result) => ({
        content: result.content,
        isError: result.isError
      }))
  })

/**
 * Projects an already-connected MCP session's tool catalog as a
 * {@link FlowBinding.Source}, one flow per tool.
 *
 * The client is a precondition, not a parameter this constructor resolves:
 * connecting is a scoped effect (it owns a subprocess), and a `Source` is not
 * scoped, so the host composes {@link McpClient.connect} once, at the same
 * place it composes every other scoped kernel service, and passes the live
 * client here.
 *
 * @category constructors
 * @since 0.1.0
 */
export const mcp = (client: McpClient.McpClient): FlowBinding.Source =>
  FlowBinding.source(`mcp/${client.server}`, client.tools.map((tool) => toolBinding(client, tool)))

/**
 * Connects to an MCP server and projects its tools in one step.
 *
 * Convenience only: `Effect.map(McpClient.connect(options), mcp)` written out
 * for the common case of one server whose connection lifetime is the flow
 * source's lifetime.
 *
 * @category constructors
 * @since 0.1.0
 */
export const connected = (
  options: McpClient.ConnectOptions
): Effect.Effect<FlowBinding.Source, McpError, ChildProcessSpawner | Scope.Scope> =>
  Effect.map(McpClient.connect(options), mcp)
