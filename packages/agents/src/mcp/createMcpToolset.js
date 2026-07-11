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

  // Drain the child's stderr. With `stderr: "pipe"` nothing reads the pipe, so
  // a server that logs verbosely blocks on write once the OS buffer (~64-80KB)
  // fills, deadlocking the session. Forward each chunk to a sink (default: the
  // host stderr) rather than discarding, so server diagnostics survive; a
  // throwing sink must never break the drain.
  const stderrStream = transport.stderr;
  if (stderrStream) {
    const sink = options.onStderr ?? ((chunk) => process.stderr.write(chunk));
    stderrStream.on("data", (chunk) => {
      try {
        sink(chunk.toString());
      }
      catch {
        // ignore sink failures; draining must continue
      }
    });
    stderrStream.on("error", () => {
      // a stderr stream error must not crash the toolset
    });
  }

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
      execute: async (input, execution) =>
        callMcpTool(client, mcpTool.name, input, execution?.abortSignal),
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
}

/**
 * Invoke one MCP tool and reduce its result to a value the model can read:
 * structured content when the server returns it, otherwise the joined text.
 *
 * @param {Client} client
 * @param {string} name
 * @param {unknown} input
 * @param {AbortSignal | undefined} signal
 * @returns {Promise<unknown>}
 */
async function callMcpTool(client, name, input, signal) {
  const abortReason = () => signal?.reason ?? new DOMException("The operation was aborted", "AbortError");
  if (signal?.aborted) throw abortReason();
  const result = await invokeMcpTool(client, name, input, signal, abortReason);
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

/**
 * @param {Client} client
 * @param {string} name
 * @param {unknown} input
 * @param {AbortSignal | undefined} signal
 * @param {() => unknown} abortReason
 */
async function invokeMcpTool(client, name, input, signal, abortReason) {
  try {
    const result = await client.callTool({
      name,
      arguments: /** @type {Record<string, unknown>} */ (input ?? {}),
    }, undefined, signal ? { signal } : undefined);
    return result;
  } catch (error) {
    // The MCP SDK wraps transport cancellation in McpError. Preserve the
    // caller's original reason so AI SDK cancellation remains observable.
    if (signal?.aborted) throw abortReason();
    throw error;
  }
}
