import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

/**
 * A REAL MCP server whose `sleep` tool takes as long as the caller asks. It is
 * the no-mocks proof that aborting an AI SDK tool call cancels the in-flight
 * MCP request: when the client sends `notifications/cancelled`, the server SDK
 * aborts the handler's `extra.signal`, and the handler reports that on stderr
 * so a test can observe server-side cancellation through the toolset's
 * stderr drain.
 */
export function createSlowMcpServer() {
  const server = new McpServer({ name: "smithers-slow", version: "0.0.0" });
  server.registerTool(
    "sleep",
    {
      description: "Wait the given number of milliseconds, then reply.",
      inputSchema: { ms: z.number() },
    },
    async ({ ms }, extra) =>
      new Promise((resolve) => {
        const timer = setTimeout(() => resolve({ content: [{ type: "text", text: "slept" }] }), ms);
        extra.signal.addEventListener("abort", () => {
          clearTimeout(timer);
          process.stderr.write("sleep-cancelled\n");
          resolve({ content: [{ type: "text", text: "cancelled" }] });
        });
      }),
  );
  return server;
}

if (import.meta.main) {
  const server = createSlowMcpServer();
  await server.connect(new StdioServerTransport(process.stdin, process.stdout));
}
