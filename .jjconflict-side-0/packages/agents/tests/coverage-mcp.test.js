import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { createMcpToolset } from "../src/mcp/createMcpToolset.js";

const DEMO_SERVER = resolve(import.meta.dir, "fixtures", "demo-mcp-server.js");
const callOptions = { toolCallId: "test-call", messages: [] };

describe("createMcpToolset error + include curation", () => {
  test("reduces an MCP tool error result to a structured error value", async () => {
    const toolset = await createMcpToolset({ command: "bun", args: [DEMO_SERVER] });
    try {
      // Invalid args fail the server-side zod schema, so the MCP server returns
      // an isError result that callMcpTool must fold into an error object.
      const result = await toolset.tools.add.execute(
        { a: /** @type {any} */ ("not-a-number"), b: 1 },
        callOptions,
      );
      expect(result).toMatchObject({ error: true, status: "failed" });
      expect(typeof result.message).toBe("string");
    } finally {
      await toolset.close();
    }
  });

  test("include filters the projected toolset", async () => {
    const toolset = await createMcpToolset(
      { command: "bun", args: [DEMO_SERVER] },
      { include: ["shout"] },
    );
    try {
      expect(toolset.toolNames).toEqual(["shout"]);
    } finally {
      await toolset.close();
    }
  });
});
