import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

/**
 * A REAL MCP server whose `flood` tool writes a large volume to stderr and,
 * like any well-behaved chatty process, respects backpressure: it awaits the
 * `drain` event before continuing. If the client never reads stderr the pipe
 * stays full, `drain` never fires, and the tool never replies. It is the
 * no-mocks proof that `createMcpToolset` drains stderr instead of deadlocking.
 */
export function createStderrFloodMcpServer() {
  const server = new McpServer({ name: "smithers-stderr-flood", version: "0.0.0" });
  server.registerTool(
    "flood",
    {
      description: "Write the requested number of bytes to stderr, then return done.",
      inputSchema: { bytes: z.number() },
    },
    async ({ bytes }) => {
      const written = await floodStderr(bytes);
      return { content: [{ type: "text", text: `flooded ${written}` }] };
    },
  );
  return server;
}

/**
 * @param {number} bytes
 * @returns {Promise<number>}
 */
async function floodStderr(bytes) {
  const chunk = Buffer.alloc(64 * 1024, 0x2e);
  let written = 0;
  while (written < bytes) {
    if (!process.stderr.write(chunk)) {
      await new Promise((resolveDrain) => process.stderr.once("drain", resolveDrain));
    }
    written += chunk.length;
  }
  return written;
}

if (import.meta.main) {
  const server = createStderrFloodMcpServer();
  await server.connect(new StdioServerTransport(process.stdin, process.stdout));
}
