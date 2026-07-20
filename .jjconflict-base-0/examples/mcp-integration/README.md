# MCP as integration

Declare an MCP server in a workflow and an agent gains its tools. This is the
inbound half of Smithers' integration strategy: instead of hand-writing a
connector per app, point `createMcpToolset` at any MCP server and its tools
become agent-callable, the same shape as `createOpenApiTools` output.

## How it works

```
createMcpToolset(config)            an SDK agent
  ├─ spawn the MCP server (stdio)     tools: mcp.tools   ──►  agent calls
  ├─ tools/list                                               add / shout / ...
  └─ wrap each tool as an AI SDK tool whose execute() does tools/call
```

`packages/agents/src/mcp/createMcpToolset.js` is the factory. It connects with
the official `@modelcontextprotocol/sdk` client, lists the server's tools, and
projects each into an AI SDK `dynamicTool` that proxies to the server on call.
It honors `include` / `exclude` / `namePrefix` for curation.

## Run it

```bash
# The deterministic demo server needs nothing. Running the agent's LLM step
# needs an Anthropic key:
ANTHROPIC_API_KEY=sk-... bun run smithers up examples/mcp-integration/workflow.tsx \
  --input '{"prompt":"What is 40 + 2? Use the add tool."}'
```

The factory itself is covered by a real-backend test (no LLM, no mocks) that
spawns the demo MCP server over stdio:

```bash
bun test packages/agents/tests/mcp-toolset.test.js
```

## Point it at a real server

Swap the `command` / `args` / `env` for any MCP server. Examples:

```ts
// GitHub
createMcpToolset(
  {
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-github"],
    env: { GITHUB_PERSONAL_ACCESS_TOKEN: process.env.GITHUB_TOKEN ?? "" },
  },
  { namePrefix: "github_" },
);

// Linear
createMcpToolset({
  command: "npx",
  args: ["-y", "mcp-remote", "https://mcp.linear.app/sse"],
});
```

## Two consumption paths

This prototype wires MCP tools into **SDK agents** (`AnthropicAgent`,
`OpenAIAgent`) as an in-process `tools` record. **CLI agents** consume MCP
through their native surfaces instead of `createMcpToolset`: Claude Code, Kimi,
and Amp expose MCP config flags, while Codex reads MCP servers from
`~/.codex/config.toml` or `codex mcp add`. A config writer that emits those
per-agent declarations from the same `McpServerConfig` is the natural follow-up
so one declaration targets both agent kinds. See issue #222.
