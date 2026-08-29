# Smithers, the Claude Code plugin

A [Claude Code plugin](https://code.claude.com/docs/en/plugins) that makes Claude
fluent in **Smithers**, the durable control plane for long-running coding agents.
Installing it gives a Claude Code session:

- the **`smithers` MCP server** (`smithers --mcp`): `list_workflows`,
  `run_workflow`, `list_runs`, `get_run`, `watch_run`, `get_run_events`,
  `explain_run`, `list_pending_approvals`, `resolve_approval`,
  `get_node_detail`, and `get_chat_transcript`;
- the **`smithers` skill**, which teaches Claude to drive Smithers as an
  orchestrator rather than hand-rolling subagents, and to run durable flows
  instead of Claude Code's own dynamic orchestration;
- a **SessionStart hook** that detects a Smithers project, lists the flows
  `smithers ls` discovered, and reports non-terminal runs;
- a **PreToolUse hook** on the native `Task`, `Agent`, and `Workflow` tools that
  reminds Claude to prefer a durable flow for long-running work. It is advisory
  and never blocks the tool;
- a **background monitor** (`smithers claude monitor`) that notifies the session
  when a run it follows needs attention: an approval pending, a failure, a stall,
  or node retry churn. It follows only the runs this session started or
  subscribed to. The `/workflows` mirror (`smithers claude tick`) and
  Claude-launched runs subscribe automatically, and
  `smithers claude subscribe <run-id>` is the explicit path. Other sessions' runs
  and pre-existing runs never notify.

> Smithers is operated by the AI agent on the human's behalf. It is not a GUI the
> human clicks. This plugin is what makes Claude Code fluent in it.

## The headline behavior

**Smithers over dynamic orchestration.** The skill and the PreToolUse hook steer
Claude away from the native Workflow tool, the Task and Agent subagent fan-out,
and `/loop` for any long-running, multi-step, or background work, and toward a
durable flow that records each step, resumes after a crash, retries on failure,
and parks on human approvals.

The one sanctioned use of the native Workflow tool is the bundled `/workflows`
mirror, `workflows/smithers-run.mjs`. It launches the detached run itself and
then reports it node by node, so the human watches a live view of work that is
actually running in the Smithers engine. Stopping the mirror never stops the run.

## Install

```sh
# From the published repository:
claude plugin marketplace add smithersai/smithers
claude plugin install smithers@smithersai

# Local development, from a clone of this repository:
claude plugin marketplace add /path/to/smithers
claude plugin install smithers@smithersai
```

Then start `claude`, run `/plugin` to confirm it is enabled, and the `smithers`
tools and skill are available. `claude plugin install` accepts `-s project` to
declare the install in the repository's settings instead of your user config.

## Layout

The plugin lives in `claude-plugin/`. The marketplace manifest that points at it
lives at the repository root in `.claude-plugin/marketplace.json`, the path
Claude Code reads when you run `claude plugin marketplace add <repo-root>`. The
plugin `source` (`./claude-plugin`) resolves relative to that marketplace root.

```
<repo-root>/
├── .claude-plugin/
│   └── marketplace.json   # marketplace entry; plugin source = ./claude-plugin
└── claude-plugin/
    ├── .claude-plugin/
    │   └── plugin.json    # manifest; the only file that lives here
    ├── .mcp.json          # registers the smithers MCP server, auto-discovered
    ├── bin/
    │   └── smithers.mjs   # launcher named by .mcp.json and monitors.json
    ├── lib/
    │   └── resolve-smithers-cli.mjs   # source checkout wins over an install
    ├── hooks/
    │   ├── hooks.json     # SessionStart and PreToolUse hooks, auto-discovered
    │   ├── session-start.mjs
    │   ├── session-start.test.mjs
    │   └── prefer-smithers.mjs
    ├── monitors/
    │   └── monitors.json  # background `smithers claude monitor`, session-scoped
    ├── workflows/
    │   └── smithers-run.mjs   # the generic /workflows mirror script
    ├── skills/
    │   └── smithers/
    │       └── SKILL.md   # the on-ramp and the use-Smithers rules
    └── README.md
```

> Per the Claude Code plugin spec, only `plugin.json` lives in
> `.claude-plugin/`. Every other component (`hooks/`, `.mcp.json`, `skills/`)
> sits at the plugin root and is auto-discovered. Hook commands reference
> bundled scripts through `${CLAUDE_PLUGIN_ROOT}`.

## Which Smithers the plugin runs

Every command the plugin issues, including the MCP server, the run monitor, the
SessionStart probes, and the `/workflows` mirror, goes through
`lib/resolve-smithers-cli.mjs`:

1. `workspace`: if the project sits inside a **Smithers source checkout**, a tree
   whose root `package.json` is named `smithers` and that has
   `packages/cli/bin/smithers.mjs`, it runs that working tree. Contributors get
   the code they are editing, not the last published release.
2. `installed`: otherwise a `node_modules/@smthrs/cli` whose manifest `name` is
   `@smthrs/cli`, run through the bin path that manifest declares. The directory
   name alone is not proof of identity, since a workspace can link anything
   there.
3. `path`: otherwise an executable named **`smithers`** on `PATH`. That is the
   bin name the published package declares, so it is unambiguous.
4. `published`: otherwise `npx --package @smthrs/cli smithers`, what a machine
   with no install gets.

Tiers 1 and 2 spawn `node`, never `bun`: the durable engine is unsupported on
Bun, and `packages/cli/bin/smithers.mjs` pins Node in its shebang for the same
reason.

Only the last tier goes through a package runner, and it names the package and
the bin separately on purpose. A bare `bunx smthrs` asks the runner to map a
name to a bin, and any project shipping its own `smthrs` bin wins that guess.
`@smthrs/build-cli` in this repository declares one, so inside it
`bunx smthrs --version` prints that package's version and every control
subcommand exits COMMAND_NOT_FOUND.

`bin/smithers.mjs` applies that choice for config files that can only name a
static command, forwarding argv and stdio unchanged. The SessionStart hook also
passes the resolved command to the mirror as `args.cli` whenever it differs from
the mirror's own default.

The resolver is copied verbatim into `codex-plugin/lib/` because each plugin
ships standalone. `scripts/check-local-smithers.mjs` fails the build if the two
copies drift.

## Requirements

- `claude` (Claude Code) with the `claude plugin` or `/plugin` interface.
- `node` 22.19 or newer on `PATH`. The hooks, the launcher, and the CLI itself
  all run on Node.
- `npx` on `PATH` for a machine with no Smithers install, which is how the
  published tier resolves.

## Tests

```sh
node --test "claude-plugin/**/*.test.mjs"
```

The suite covers the four resolver tiers, the byte-identity of the two resolver
copies, the SessionStart context the hook builds, and the mirror's contract
version and command surface.
