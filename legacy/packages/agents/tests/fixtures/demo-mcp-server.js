import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

/**
 * A tiny, deterministic MCP server used as a REAL backend (no mocks) for the
 * `createMcpToolset` test and the `examples/mcp-integration` workflow. Run it
 * directly (`bun demo-mcp-server.js`) to serve over stdio.
 */
export function createDemoMcpServer() {
  const server = new McpServer({ name: "smithers-demo", version: "0.0.0" });
  server.registerTool(
    "add",
    {
      description: "Add two numbers and return their sum.",
      inputSchema: { a: z.number(), b: z.number() },
    },
    async ({ a, b }) => ({ content: [{ type: "text", text: String(a + b) }] }),
  );
  server.registerTool(
    "shout",
    {
      description: "Return the given text in upper case.",
      inputSchema: { text: z.string() },
    },
    async ({ text }) => ({ content: [{ type: "text", text: text.toUpperCase() }] }),
  );
  return server;
}

if (import.meta.main) {
  const server = createDemoMcpServer();
  await server.connect(new StdioServerTransport(process.stdin, process.stdout));
}
