import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const server = new McpServer({ name: "smithers-pending", version: "0.0.0" });

server.registerTool(
  "wait_forever",
  {
    description: "Stay pending until the client cancels the MCP request.",
    inputSchema: {},
  },
  () => new Promise(() => {}),
);

await server.connect(new StdioServerTransport(process.stdin, process.stdout));
