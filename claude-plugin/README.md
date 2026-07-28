# Smithers — Claude Code plugin

A [Claude Code plugin](https://code.claude.com/docs/en/plugins) that makes Claude
fluent in **Smithers**, the durable control plane for long-running coding agents.
Installing it gives a Claude Code session:

- the **`smithers` MCP server** (`smithers-orchestrator --mcp`) — `list_workflows`,
  `run_workflow`, `watch_run`, `resolve_approval`, and the rest of the semantic
  tool surface;
- the **`smithers` skill** — teaches Claude to drive Smithers as an orchestrator
  (not hand-rolled subagents), **mandates a live custom UI for every workflow**,
  and tells Claude to run durable Smithers workflows instead of Claude Code's own
  dynamic orchestration;
- a **SessionStart hook** that detects a `.smithers/` project, lists its workflows,
  and flags any that still need a UI;
- a **PreToolUse hook** on the native `Task` / `Agent` / `Workflow` tools that
  reminds Claude to prefer a durable Smithers workflow for long-running work
  (advisory only — it never blocks the tool);
- a **background monitor** (`smithers claude monitor`) that notifies the session
  when a run it follows needs attention (approval pending, human request,
  failed, stalled). It follows only the runs this session started or subscribed
  to: the /workflows mirror (`smithers claude tick`) and Claude-launched runs
  subscribe automatically, `smithers claude subscribe <runId>` is the explicit
  path. Other sessions' runs and pre-existing runs never notify.

> Smithers is operated by the AI agent on the human's behalf — it is not a GUI the
> human clicks. This plugin is what makes Claude Code fluent in it.

Launches made through the bundled `/workflows` mirror are durably attributed to
`claude-code` and include `CLAUDE_CODE_SESSION_ID` when present. Pass the
optional mirror argument `startedByPrompt` only for deliberate launch context;
workflow input and transcripts are never copied into attribution.

## The two headline behaviors

1. **Smithers over dynamic orchestration.** The skill and the PreToolUse hook
   steer Claude away from the native Workflow tool, the Task/Agent subagent
   fan-out, and `/loop` for any long-running, multi-step, or background work, and
   toward a durable Smithers workflow that persists each step, resumes after a
   crash, retries on failure, and gates on human approvals.
2. **A live UI for every workflow.** Whenever Claude creates or runs a workflow it
   authors a standalone React UI at `.smithers/ui/<key>.tsx` (composed from the
   `smithers-orchestrator/gateway-ui` run widgets and `smithers-orchestrator/ui`
   primitives over the `smithers-orchestrator/gateway-react` hooks) and launches it with
   `smithers ui <runId>`, so the human watches the run live in their browser
   instead of reading text summaries. See
   [`skills/smithers/SKILL.md`](./skills/smithers/SKILL.md) for the exact
   authoring contract and a working example.

## Install

```bash
# From the published repo (once distributed):
claude plugin marketplace add smithersai/smithers
claude plugin install smithers@smithersai

# Local development (from a clone of this repo):
claude plugin marketplace add /path/to/smithers
claude plugin install smithers@smithersai
```

Then start `claude`, run `/plugin` to confirm it's enabled, and the `smithers`
tools + skill are available. (`claude plugin install` accepts `-s project` to
declare the install in the repo's settings instead of your user config.)

## Layout

The plugin lives in `claude-plugin/`; the marketplace manifest that points at it
lives at the repo root in `.claude-plugin/marketplace.json` — the path Claude Code
reads when you run `claude plugin marketplace add <repo-root>`. The plugin
`source` (`./claude-plugin`) resolves relative to that marketplace root (the
directory containing `.claude-plugin/`), which is the repo root.

```
<repo-root>/
├── .claude-plugin/
│   └── marketplace.json   # marketplace entry; plugin source = ./claude-plugin
└── claude-plugin/
    ├── .claude-plugin/
    │   └── plugin.json     # manifest (the only file that lives here)
    ├── .mcp.json           # registers the smithers MCP server (auto-discovered)
    ├── bin/
    │   └── smithers.mjs     # launcher named by .mcp.json and monitors.json
    ├── lib/
    │   └── resolve-smithers-cli.mjs  # source checkout > published package
    ├── hooks/
    │   ├── hooks.json       # SessionStart + PreToolUse hooks (auto-discovered)
    │   ├── session-start.mjs
    │   └── prefer-smithers.mjs
    ├── monitors/
    │   └── monitors.json    # background `smithers claude monitor` (session-scoped)
    ├── workflows/
    │   └── smithers-run.mjs # the generic /workflows mirror script
    ├── skills/
    │   └── smithers/
    │       └── SKILL.md     # the on-ramp + mandatory-UI + use-Smithers rules
    └── README.md
```

> Per the Claude Code plugin spec: only `plugin.json` lives in `.claude-plugin/`.
> Every other component (`hooks/`, `.mcp.json`, `skills/`) sits at the plugin root
> and is auto-discovered. Hook commands reference bundled scripts via
> `${CLAUDE_PLUGIN_ROOT}`.

## Which Smithers the plugin runs

Every command the plugin issues — the MCP server, the run monitor, the
SessionStart run count, the `/workflows` mirror — goes through
`lib/resolve-smithers-cli.mjs`:

1. If the project sits inside a **Smithers source checkout** (a tree whose root
   `package.json` is named `smithers-monorepo` and that has
   `apps/cli/src/index.js`), it runs that working tree. Contributors get the code
   they are editing, not the last published release.
2. Otherwise it runs `bunx smithers-orchestrator` — the published package.

`bin/smithers.mjs` applies that choice for config files that can only name a
static command, forwarding argv and stdio unchanged. In a checkout the
SessionStart hook also passes the resolved command to the mirror as `args.cli`.

## Requirements

- `claude` (Claude Code) with the `claude plugin` / `/plugin` interface.
- `bunx` on PATH (the MCP server launches via `bunx smithers-orchestrator --mcp`
  unless a source checkout is detected, in which case it runs `bun` on that tree).
- `node` on PATH (the hooks and the launcher are dependency-free Node ESM scripts).
