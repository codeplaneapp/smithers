---
name: smithers-ask
description: Ask a question about Smithers using your installed agent and the Smithers MCP server. Run `smithers ask --help` for usage details.
requires_bin: smithers
command: smithers ask
---

# smithers ask

Ask a question about Smithers using your installed agent and the Smithers MCP server.

## Arguments

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `question` | `string` | no | The question to ask |

## Options

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--agent` | `string` |  | Explicitly select which agent CLI to use |
| `--listAgents` | `boolean` | `false` | List detected agents plus their bootstrap mode and exit |
| `--dumpPrompt` | `boolean` | `false` | Print the generated system prompt and exit |
| `--toolSurface` | `string` | `semantic` | Choose which Smithers MCP tool surface to expose |
| `--mcp` | `boolean` | `true` | Bootstrap the Smithers MCP server. Use --no-mcp for prompt-only fallback. |
| `--printBootstrap` | `boolean` | `false` | Print the selected bootstrap configuration and exit |
