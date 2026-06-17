/** @jsxImportSource smithers-orchestrator */
import { resolve } from "node:path";
import { AnthropicAgent } from "@smithers-orchestrator/agents";
import { createMcpToolset } from "@smithers-orchestrator/agents/mcp/createMcpToolset";
import { Task, Workflow } from "smithers-orchestrator";
import { z } from "zod";
import { createExampleSmithers } from "../_example-kit.js";

const { smithers, outputs } = createExampleSmithers({
  answer: z.object({ summary: z.string() }),
});

// Declare an MCP server as an integration. Its tools become agent-callable with
// zero per-connector code. This points at the deterministic demo server so the
// example runs offline; swap `command`/`args`/`env` for a real one, e.g.:
//
//   const mcp = await createMcpToolset(
//     {
//       command: "npx",
//       args: ["-y", "@modelcontextprotocol/server-github"],
//       env: { GITHUB_PERSONAL_ACCESS_TOKEN: process.env.GITHUB_TOKEN ?? "" },
//     },
//     { namePrefix: "github_" },
//   );
//
const mcp = await createMcpToolset({
  command: "bun",
  args: [resolve(import.meta.dir, "../../packages/agents/tests/fixtures/demo-mcp-server.js")],
});

// The agent gains the MCP tools the same way it would take OpenAPI-generated
// tools: as its `tools` record. (Running the LLM needs ANTHROPIC_API_KEY.)
const agent = new AnthropicAgent({
  id: "mcp-agent",
  model: "claude-sonnet-4-6",
  instructions: "Use the available tools to answer. Prefer calling a tool over guessing.",
  tools: mcp.tools,
});

export default smithers((ctx) => (
  <Workflow name="mcp-integration-example">
    <Task id="answer" agent={agent} output={outputs.answer}>
      {String(
        (ctx.input as { prompt?: unknown } | undefined)?.prompt ??
          "What is 2 + 3? Call the add tool, then summarize the result.",
      )}
    </Task>
  </Workflow>
));
