# agent-wiring

Supplementary wiring for agents that the incur-based `mcp add` / `skills add`
framework does not reach: Hermes (YAML config + native plugin), OpenClaw (JSON
config + native extension), and Pi (skills directory copy).

How it fits: the CLI entry (`src/index.js`) calls `parseAgentWiringArgv` to
recognize an `mcp add` / `skills add` argv, then `wireExtraAgents` dispatches
by kind — `registerHermesMcp` / `registerHermesPlugin` / `registerOpenClawMcp`
/ `registerOpenClawPlugin` for `"mcp"`, `linkPiSkills` for `"skills"`.
`mcpAddFallbackMessage` builds the recovery text printed when auto-registration
fails.

Conventions:

- Every writer detects its agent by config-dir presence, preserves all existing
  config (skipping with reason `"unparseable-config"` rather than clobbering),
  and returns a uniform `{ agent, path, reason? }`-shaped result.
- Plugin/extension trees are replaced wholesale so re-runs are idempotent.
- `wireExtraAgents` picks the MCP launcher (`npx`/`pnpx`/`bunx`) the same way
  incur does, so all agents get a runner that exists on the host.

Tests: `apps/cli/tests/agent-wiring.test.js` covers argv parsing, the fallback
message, and the config writers against temp home dirs.
