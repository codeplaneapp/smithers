# Smithers OpenClaw plugin

Native OpenClaw plugin for driving Smithers durable workflows.

It provides:

- Smithers run/inspect/approval/output tools.
- `smithers_create_workflow` for turning repeatable work into durable workflows.
- `smithers_eval` and `smithers_optimize` for improving workflows from evidence.
- A bundled `smithers-orchestrate` skill that steers OpenClaw toward reusable,
  eval-backed workflows instead of repeated ad-hoc turns.
- A prompt hook that surfaces the Smithers operating policy and live run status.
- A static non-technical marketing page in `site/` for introducing OpenClaw's
  workflow loop.

Smithers installs this plugin as part of:

```bash
bunx smithers-orchestrator mcp add --agent openclaw
```

The same command also writes the Smithers MCP server into
`~/.openclaw/openclaw.json` as a baseline tool surface.
