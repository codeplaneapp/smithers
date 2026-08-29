# Smithers — Codex plugin

A [Codex plugin](https://developers.openai.com/codex/plugins) that makes Codex
fluent in **Smithers**, the durable control plane for long-running coding agents.
Installing it gives a Codex session:

- the **`smithers` MCP server** (`smthrs --mcp`) — `list_workflows`,
  `run_workflow`, `watch_run`, `resolve_approval`, and the rest of the semantic
  tool surface;
- the **`smithers` skill** — teaches Codex to drive Smithers as an orchestrator
  (not hand-rolled subagents) **and mandates a live custom UI for every workflow**;
- a **SessionStart hook** that detects a `.smithers/` project, lists its workflows,
  and flags any that still need a UI.
- an optional **durable native spawn-tool routing policy** under `scripts/`, for
  Codex 0.144+; it writes Smithers guidance into Codex's native multi-agent hints.

> Smithers is operated by the AI agent on the human's behalf — it is not a GUI the
> human clicks. This plugin is what makes Codex fluent in it.

## The headline behavior: a live UI for every workflow

The skill enforces a hard rule: whenever Codex creates or runs a workflow, it
authors a standalone React UI at `.smithers/ui/<key>.tsx` (composed from the
`smthrs/gateway-ui` run widgets and `smthrs/ui`
primitives over the `smthrs/gateway-react` hooks) and launches it with
`smithers ui <runId>`, so the human watches the run live in their browser instead
of reading text summaries. See [`skills/smithers/SKILL.md`](./skills/smithers/SKILL.md)
for the exact authoring contract and a working example.

## Install

```bash
# From the published repo (once distributed):
codex plugin marketplace add smithersai/smithers
codex plugin add smithers@smithersai

# Local development (from a clone of this repo):
codex plugin marketplace add /path/to/smithers
codex plugin add smithers@smithersai
```

Then start `codex`, run `/plugins` to confirm it's enabled, and the `smithers`
tools + skill are available.

## Layout

The plugin lives in `codex-plugin/`; the marketplace manifest that points at it
lives at `.agents/plugins/marketplace.json` (the only marketplace path Codex
discovers in a repo root). `codex plugin marketplace add <repo-root>` reads that
manifest and resolves the plugin `source.path` (`./codex-plugin`) relative to the
repo root.

```
<repo-root>/
├── .agents/plugins/
│   └── marketplace.json   # marketplace entry; source.path = ./codex-plugin
└── codex-plugin/
    ├── .codex-plugin/
    │   └── plugin.json    # manifest (the only file that lives here)
    ├── .mcp.json          # registers the smithers MCP server (key: mcpServers)
    ├── lib/
    │   └── resolve-smithers-cli.mjs  # source checkout > published package
    ├── hooks/
    │   ├── hooks.json      # SessionStart hook (auto-discovered; NOT a manifest field)
    │   └── session-start.mjs
    ├── scripts/
    │   ├── configure-codex-routing.mjs  # App Server setup/status/disable CLI
    │   └── configure-codex-routing.test.mjs
    ├── skills/
    │   └── smithers/
    │       └── SKILL.md    # the on-ramp + the mandatory-UI authoring contract
    └── README.md
```

The routing configurator uses Codex App Server JSON-RPC and a namespaced snapshot
in `$CODEX_HOME/.smithers-codex-routing.json`; it never manages model routing or
spawn metadata. Run it using its installed absolute plugin path (the path
containing `scripts/`, not the current workspace), for example
`node <plugin-dir>/scripts/configure-codex-routing.mjs --status`. See the durable
routing section in the skill for setup commands.

> Codex's plugin validator (≥ 0.142) rejects a `hooks` field in `plugin.json`, so
> hooks are auto-discovered from `hooks/hooks.json` instead, and `.mcp.json` must
> use the `mcpServers` key (not `mcp_servers`).

## Requirements

- `codex` ≥ 0.142 (the version that ships `codex plugin` / the marketplace).
- `bunx` on PATH (the MCP server launches via `bunx smthrs --mcp`,
  and the skill launches the live UI via `bunx smthrs ui <runId>`,
  so no separate global `smithers` install is required — if `smithers` *is* on
  PATH the skill uses it directly). Inside a **Smithers source checkout** both
  paths end up on that working tree instead of the published build: the
  SessionStart hook resolves it through `lib/resolve-smithers-cli.mjs`, and the
  published bin's own delegation re-execs into `apps/cli/src/index.js`. Codex
  does not substitute `${PLUGIN_ROOT}` in `.mcp.json`, so the MCP entry itself
  stays on `bunx` and relies on that delegation.
- `node` on PATH (the SessionStart hook is a dependency-free Node ESM script).
