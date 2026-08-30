# Smithers, the Codex plugin

A [Codex plugin](https://developers.openai.com/codex/plugins) that makes Codex
fluent in **Smithers**, the durable control plane for long-running coding agents.
Installing it gives a Codex session:

- the **`smithers` MCP server** (`smithers --mcp`): `list_workflows`,
  `run_workflow`, `list_runs`, `get_run`, `watch_run`, `get_run_events`,
  `explain_run`, `list_pending_approvals`, `resolve_approval`,
  `get_node_detail`, and `get_chat_transcript`;
- the **`smithers` skill**, which teaches Codex to drive Smithers as an
  orchestrator rather than hand-rolling subagents;
- a **SessionStart hook** that detects a Smithers project and lists the flows
  `smithers ls` discovered;
- an optional **native spawn-tool routing policy** under `scripts/`, for Codex
  0.144 and newer. It writes Smithers guidance into Codex's own multi-agent
  hints.

> Smithers is operated by the AI agent on the human's behalf. It is not a GUI the
> human clicks. This plugin is what makes Codex fluent in it.

## The headline behavior

**Smithers over ad-hoc subagents.** The skill routes long-running, multi-step,
and background work into a durable flow that records each step, resumes after a
crash, retries on failure, and parks on human approvals, instead of a subagent
fan-out that loses everything when the turn ends.

A flow is ordinary TypeScript built from `Flow.make`, `Action.make`, and Effect,
discovered under `flows/<name>/`. Smithers 1.0 has no JSX authoring API and no
`.smithers/` pack. See [`skills/smithers/SKILL.md`](./skills/smithers/SKILL.md)
for the model and the command surface.

## Install

```sh
# From the published repository:
codex plugin marketplace add smithersai/smithers
codex plugin add smithers@smithersai

# Local development, from a clone of this repository:
codex plugin marketplace add /path/to/smithers
codex plugin add smithers@smithersai
```

Then start `codex`, run `/plugins` to confirm it is enabled, and the `smithers`
tools and skill are available.

## Layout

The plugin lives in `codex-plugin/`. The marketplace manifest that points at it
lives at `.agents/plugins/marketplace.json`, the only marketplace path Codex
discovers in a repository root. `codex plugin marketplace add <repo-root>` reads
that manifest and resolves the plugin `source.path` (`./codex-plugin`) relative
to the repository root.

```
<repo-root>/
├── .agents/plugins/
│   └── marketplace.json   # marketplace entry; source.path = ./codex-plugin
└── codex-plugin/
    ├── .codex-plugin/
    │   └── plugin.json    # manifest; the only file that lives here
    ├── .mcp.json          # registers the smithers MCP server, key: mcpServers
    ├── lib/
    │   └── resolve-smithers-cli.mjs   # source checkout wins over an install
    ├── hooks/
    │   ├── hooks.json     # SessionStart hook, auto-discovered, not a manifest field
    │   ├── session-start.mjs
    │   └── session-start.test.mjs
    ├── scripts/
    │   ├── configure-codex-routing.mjs       # App Server setup, status, disable
    │   └── configure-codex-routing.test.mjs
    ├── skills/
    │   └── smithers/
    │       └── SKILL.md   # the on-ramp and the command surface
    └── README.md
```

The routing configurator speaks Codex App Server JSON-RPC and keeps a namespaced
snapshot in `$CODEX_HOME/.smithers-codex-routing.json`. It never manages model
routing or spawn metadata. Run it through its installed absolute plugin path,
the directory containing `scripts/`, not the current workspace:

```sh
node <plugin-dir>/scripts/configure-codex-routing.mjs --status
```

> Codex's plugin validator (0.142 and newer) rejects a `hooks` field in
> `plugin.json`, so hooks are auto-discovered from `hooks/hooks.json` instead,
> and `.mcp.json` must use the `mcpServers` key rather than `mcp_servers`.

## Which Smithers the plugin runs

The SessionStart hook resolves the CLI through `lib/resolve-smithers-cli.mjs`,
in four tiers:

1. `workspace`: a Smithers source checkout, a tree whose root `package.json` is
   named `smithers` and that has `packages/cli/bin/smithers.mjs`. Contributors
   get the code they are editing.
2. `installed`: a `node_modules/@smthrs/cli` whose manifest `name` is
   `@smthrs/cli`, run through the bin path that manifest declares.
3. `path`: an executable named `smithers` on `PATH`.
4. `published`: `npx --package @smthrs/cli smithers`.

Tiers 1 and 2 spawn `node`, never `bun`: the durable engine is unsupported on
Bun. The resolver is a verbatim copy of `claude-plugin/lib/resolve-smithers-cli.mjs`
because each plugin ships standalone, and `scripts/check-local-smithers.mjs`
fails the build if the two copies drift.

Codex does not substitute `${PLUGIN_ROOT}` in `.mcp.json`, so the MCP entry
cannot name the resolver. It runs `npx --package @smthrs/cli smithers --mcp`
directly, which names the package and the bin separately rather than asking the
runner to guess a bin from a package name.

## Requirements

- `codex` 0.142 or newer, the version that ships `codex plugin` and the
  marketplace.
- `node` 22.19 or newer on `PATH`. The SessionStart hook, the routing
  configurator, and the CLI all run on Node.
- `npx` on `PATH`, which is how the MCP entry and the published resolver tier
  launch the CLI.

## Tests

```sh
cd codex-plugin && bun test
```

The suite covers the App Server routing configurator and the SessionStart hook.
