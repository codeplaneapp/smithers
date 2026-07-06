# MCP server and agent wiring

> **Status:** Partial | **Priority:** P0 | **Owner:** smithers-maintainers | **Group:** Connect agents

Smithers can run as a Model Context Protocol stdio server with semantic and raw tool surfaces, and the CLI wires MCP/skill/install instructions into supported coding agents.

## What you can do

Let Claude Code, Codex, Cursor, Hermes, OpenClaw, Pi, and other agents list, run, inspect, and control durable workflows without shell scraping.

## Capabilities

### Semantic MCP tools

Structured tools return { ok, data, error } envelopes with zod schemas and MCP annotations.

### Raw CLI surface

--surface raw exposes CLI-mirroring tools for clients that need parity with shell commands.

### Tool scoping

--allowed-tools and --read-only restrict the semantic surface for safer outbound clients.

### Agent config writers

mcp add, skills add, and agent-specific supplementary wiring update supported agent configs without hand-editing JSON/TOML/YAML.

## Endpoints and commands

- `CLI smithers --mcp` ([docs](docs/integrations/mcp-server.mdx))
- `CLI smithers mcp add` ([docs](docs/agents/overview.mdx))
- `CLI smithers skills add` ([docs](docs/agents/overview.mdx))

## Related docs

- [MCP server](docs/integrations/mcp-server.mdx)
- [Agent support](docs/agents/overview.mdx)
- [MCP toolset](docs/integrations/mcp-toolset.mdx)

## Test cases

- `apps/cli/tests/semantic-mcp.test.js`
- `apps/cli/tests/semantic-tools-unit.test.js`
- `apps/cli/tests/ask-human-mcp.test.js`
- `apps/cli/tests/agent-wiring.test.js`
- `apps/cli/tests/hermes-plugin-tools.e2e.test.js`
- `apps/cli/tests/smithers-skill-contract.test.js`
- `apps/cli/tests/installCuratedSkill.test.js`

## Observability

- MCP tools echo structuredContent and text JSON payloads so clients can persist exact tool results.
- Tool annotations declare read-only, destructive, idempotent, and open-world behavior for MCP clients.

## Debugging

- Run bunx smithers-orchestrator --mcp --surface semantic and inspect registered tools from the MCP client.
- If mcp add fails due command word-splitting, `docs/integrations/mcp-server.mdx` documents the agent-specific fallback command with -- separators.

## Architecture

- `apps/cli/src/mcp/mcp-mode.js` and semantic tool helpers register MCP server mode from the same CLI binary.
- `docs/integrations/mcp-server.mdx` documents the tool envelope, annotations, surfaces, and setup.
- `docs/agents/overview.mdx` lists skill, MCP, and instruction surfaces by agent.

## Fixes and diffs

- 2026-07-06 refresh: read README.md, package exports, selected package entry points, `docs/how-it-works.mdx`, `docs/cli/overview.mdx`, `docs/agents/overview.mdx`, `docs/integrations/custom-ui.mdx`, `docs/integrations/mcp-server.mdx`, `docs/deployment/production-hardening.mdx`, `docs/deployment/control-plane.mdx`, and targeted test inventories.
- `apps/cli/src/mcp`
- `apps/cli/src/agent-wiring`
- `apps/cli/tests/semantic-mcp.test.js`
- `docs/integrations/mcp-server.mdx`
- `docs/agents/*.mdx`

## Open gaps

- The support matrix spans many external agents; not every agent-specific config path can be exercised end to end in CI.
