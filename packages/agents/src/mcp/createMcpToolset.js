import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { dynamicTool, jsonSchema } from "ai";

/** @typedef {import("./McpServerConfig.ts").McpServerConfig} McpServerConfig */
/** @typedef {import("./McpToolset.ts").McpToolset} McpToolset */
/** @typedef {import("./McpToolsetOptions.ts").McpToolsetOptions} McpToolsetOptions */

/**
 * Connect to an MCP server and expose its tools as AI SDK tools an agent can call.
 *
 * This is the inbound half of MCP-as-integration: declare a server, get back a
 * `Record<string, Tool>` to hand to an SDK agent's `tools`. Each generated tool
 * proxies to the server via `tools/call` on demand, so the agent discovers and
 * invokes them mid reasoning loop. The returned `close()` MUST be called to
 * disconnect and terminate the spawned server process.
 *
 * @param {McpServerConfig} config
 * @param {McpToolsetOptions} [options]
 * @returns {Promise<McpToolset>}
 */
export async function createMcpToolset(config, options = {}) {
  const transport = new StdioClientTransport({
    command: config.command,
    args: config.args ?? [],
    ...(config.env ? { env: config.env } : {}),
    ...(config.cwd ? { cwd: config.cwd } : {}),
    stderr: "pipe",
  });
  drainStderr(transport, options.onStderr);
  const client = new Client({
    name: options.clientName ?? "smithers-mcp-toolset",
    version: options.clientVersion ?? "0.0.0",
  });
  await client.connect(transport);

  const prefix = options.namePrefix ?? "";
  const listed = await client.listTools();
  /** @type {Record<string, import("ai").Tool>} */
  const tools = {};
  for (const mcpTool of listed.tools) {
    if (options.include && !options.include.includes(mcpTool.name)) continue;
    if (options.exclude && options.exclude.includes(mcpTool.name)) continue;
    tools[`${prefix}${mcpTool.name}`] = dynamicTool({
      description: mcpTool.description ?? mcpTool.name,
      inputSchema: jsonSchema(/** @type {any} */ (mcpTool.inputSchema ?? { type: "object", properties: {} })),
      execute: async (input, callOptions) => callMcpTool(client, mcpTool.name, input, callOptions?.abortSignal),
    });
  }

  return {
    tools,
    toolNames: Object.keys(tools),
    close: () => client.close(),
  };
}

/**
 * Continuously consume the child's stderr so a chatty MCP server never blocks.
 * With `stderr: "pipe"` the SDK pipes the child's stderr into a PassThrough that
 * applies backpressure once its buffer fills; with no reader that backpressure
 * stalls the child's writes (~80KB in) and the whole toolset deadlocks. The
 * getter returns the PassThrough immediately, so attaching before `connect()`
 * also captures any early startup output.
 *
 * @param {StdioClientTransport} transport
 * @param {((chunk: string) => void) | undefined} onStderr
 */
function drainStderr(transport, onStderr) {
  const stream = transport.stderr;
  if (!stream) return;
  const sink = onStderr ?? ((text) => void process.stderr.write(text));
  stream.on("data", (chunk) => {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    try {
      sink(text);
    } catch {
      // A throwing sink must never break the drain loop, or the pipe re-fills.
    }
  });
  stream.on("error", () => {
    // A stderr stream error must not crash the toolset.
  });
}

/**
 * Invoke one MCP tool and reduce its result to a value the model can read:
 * structured content when the server returns it, otherwise the joined text.
 *
 * The AI SDK's per-call abort signal is forwarded as the MCP request's
 * cancellation signal, so aborting the agent run rejects the pending call
 * immediately AND sends `notifications/cancelled` to the server, instead of
 * leaving the MCP operation running to its (60s default) timeout.
 *
 * @param {Client} client
 * @param {string} name
 * @param {unknown} input
 * @param {AbortSignal} [abortSignal]
 * @returns {Promise<unknown>}
 */
async function callMcpTool(client, name, input, abortSignal) {
  const result = await client.callTool(
    {
      name,
      arguments: /** @type {Record<string, unknown>} */ (input ?? {}),
    },
    undefined,
    abortSignal ? { signal: abortSignal } : undefined,
  );
  const parts = Array.isArray(result.content) ? result.content : [];
  let text = "";
  for (const part of parts) {
    const item = /** @type {{ type?: string; text?: string }} */ (part);
    if (item.type === "text" && typeof item.text === "string") {
      text += text ? `\n${item.text}` : item.text;
    }
  }
  if (result.isError) {
    return { error: true, message: text || `MCP tool "${name}" failed`, status: "failed" };
  }
  return result.structuredContent ?? text;
}
