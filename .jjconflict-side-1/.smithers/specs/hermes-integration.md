# Hermes ↔ Smithers tight integration

Status: in progress (2026-06-27)
Owner: will@smithers.sh

## Why

[Hermes Agent](https://hermes-agent.nousresearch.com) (Nous Research) is a
self-improving CLI coding agent, a peer of Claude Code and Codex, with a rich
Python plugin system. Today Smithers touches Hermes at the shallowest possible
tier: `smithers init` (via `wireExtraAgents` → `registerHermesMcp`) writes a
`smithers` entry into `~/.hermes/config.yaml` `mcp_servers`, so Hermes sees
Smithers as a flat MCP toolset. That is the right idea executed at the lowest
level. MCP cannot push, cannot register slash commands, cannot surface approval
buttons, and cannot make Hermes aware of in-flight durable runs.

There is also no Smithers driver for Hermes-the-agent. Every other CLI agent
(Claude Code, Codex, Kimi, Forge, …) can be a `<Task agent={…}>` node; Hermes
cannot, because the existing `HermesAgent` points at the Hermes *model* over an
OpenAI-compatible API, not the `hermes` binary.

This spec makes the relationship bidirectional and tight:

1. **Smithers drives Hermes** — a `HermesCliAgent` that spawns the `hermes`
   binary, so a workflow `<Task>` can delegate to Hermes.
2. **Hermes drives Smithers natively** — a first-class Hermes plugin (not just
   an MCP entry) that turns Smithers into Hermes's durable control plane:
   slash commands, lifecycle hooks, a status injector, gateway push-back, Slack
   approval buttons, and a bundled skill.

## Part 1 — `HermesCliAgent` (Smithers drives Hermes)

A new CLI-backed agent in `packages/agents`, modeled on `ForgeAgent`.

- File: `packages/agents/src/HermesCliAgent.js` + `HermesCliAgentOptions.ts`.
- Class name `HermesCliAgent` to disambiguate from the existing model wrapper
  `HermesAgent`. `cliEngine = "hermes"`, adapter id `"hermes"`.
- Headless invocation: `hermes -z "<prompt>"` is the one-shot entry point —
  single prompt in, final response text out, nothing else on stdout/stderr.
  Flags: `-m/--model`, `--provider`, `-c/--continue [name]` (resume latest /
  named), `-r/--resume <session>` (resume by id). Working dir handled by
  spawning with `cwd`.
- `buildCommand` emits `["-z", fullPrompt]` plus mapped option flags;
  `outputFormat: "text"`. System prompt is prepended to the prompt (Hermes `-z`
  has no separate system-prompt flag).
- `createOutputInterpreter` mirrors `ForgeAgent`: emit `started` on first line /
  exit, `completed` on exit with `ok` from exit code.
- Capability registry `createHermesCliCapabilityRegistry`: `engine: "hermes"`,
  MCP `bootstrap: "unsupported"` (Hermes MCP is config-driven, not bootstrapped
  by us per-run), `skills.supportsSkills: false`, no UI requests.
- Wire-up:
  - export `HermesCliAgent` + typedef from `packages/agents/src/index.js` /
    `index.d.ts`.
  - add `"hermes"` to `CliAgentCapabilityAdapterId`.
  - add a `hermes` entry to `CLI_AGENT_SURFACE_MANIFEST` and to
    `getCliAgentCapabilityReport` (`buildRegistry`).
  - add a `hermes` detector to `agent-detection.js` (binary `hermes`, auth
    signal `~/.hermes/config.yaml`). Not added to role-preference pools to keep
    existing pool behavior/tests stable.
- Tests: a `buildCommand` unit test (prompt/model/provider/resume flag mapping,
  no binary needed) and a guarded real-CLI e2e that skips when `hermes` is not
  on PATH (mirrors the amp/forge/kimi guard so CI stays green).

## Part 2 — the native Hermes plugin (Hermes drives Smithers)

Authored as real Python/YAML/Markdown files under
`apps/cli/src/hermes-plugin/` (ships verbatim — `apps/cli` runs from `src/` and
publishes `files: ["src/"]`). `registerHermesPlugin` copies the tree into
`~/.hermes/plugins/smithers/` and the gateway hook into `~/.hermes/hooks/smithers/`.

### Plugin layout

```
apps/cli/src/hermes-plugin/
├── plugin.yaml              # manifest: name, version, provides_tools/_hooks
├── __init__.py              # register(ctx): tools, hooks, commands, cli, skill, slack
├── smithers_cli.py          # thin subprocess wrapper around the `smithers` binary
├── tools.py                 # LLM tool handlers (run/ps/inspect/approve/deny/output)
├── schemas.py               # OpenAI-format tool schemas
├── hooks.py                 # pre_llm_call status injector, post_tool_call, subagent_stop, on_session_end
├── commands.py              # slash commands: /smithers ...
└── skills/
    └── orchestrate/SKILL.md # bundled, namespaced skill: smithers:orchestrate
```

Gateway hook (separate root):

```
apps/cli/src/hermes-plugin-hooks/smithers/
├── HOOK.yaml                # fires on agent:end, session:start
└── handler.py               # posts run summaries back into the gateway session
```

### Extension surfaces used (Hermes plugin API)

- **Tools** (`ctx.register_tool(name, toolset="smithers", schema, handler)`):
  `smithers_run`, `smithers_ps`, `smithers_inspect`, `smithers_approve`,
  `smithers_deny`, `smithers_output`, `smithers_ask_human_answer`. Each handler
  shells out to the `smithers` CLI and returns a JSON string (Hermes contract:
  always return `json.dumps(...)`, never raise).
- **Slash commands** (`ctx.register_command(name, handler, description)`):
  `/smithers` dispatcher (`run`, `ps`, `inspect`, `approve`, `deny`, `watch`),
  usable from CLI and every gateway (Discord/Telegram/Slack).
- **CLI subcommands** (`ctx.register_cli_command`): `hermes smithers <sub>`.
- **`pre_llm_call` hook** — status injector. Returns
  `{"context": "<live run status>"}` listing active/paused Smithers runs and any
  pending approval gates, so Hermes is aware of in-flight durable work every turn
  without being asked. Cheap: one `smithers ps --json` call, skipped if none.
- **`post_tool_call` hook** — when a `smithers_run` tool call returns a run id,
  remember it on the session so later turns can reference "the run".
- **`subagent_stop` hook** — when Hermes's own `delegate_task` finishes, offer to
  promote the result into a durable Smithers run (logged hint; no auto-action).
- **`on_session_end` / gateway hook** — push a final run summary back into the
  originating gateway session via `ctx.inject_message(...)`.
- **Slack approval buttons** (`ctx.register_slack_action_handler(action_id, cb)`):
  `smithers_approve:<runId>:<nodeId>` and `smithers_deny:<runId>:<nodeId>`
  action ids map a button click to `smithers approve/deny <runId> --node <nodeId>`.
- **Bundled skill** (`ctx.register_skill("orchestrate", path)`): namespaced
  `smithers:orchestrate`, a Hermes-tuned pointer that tells Hermes to prefer
  Smithers and to author workflows (loaded on demand via `skill_view`).

### Approval-bridge / correlation contract

The single contract worth nailing down: a Slack/gateway approval button must map
deterministically back to a Smithers gate.

- Action id format: `smithers_approve:<runId>:<nodeId>` (and `…_deny:…`). Both
  ids come from `smithers ps --json` / `smithers inspect <run> --json`
  (`pendingApprovals[].nodeId`). Colons are safe because run ids are
  `run_<alnum>` and node ids are kebab/alnum.
- The handler runs `smithers approve <runId> --node <nodeId> --by <hermes-user>`
  (or `deny`). `--by` is the gateway user id so the decision is attributed.
- The status injector and `/smithers ps` surface the exact action ids so a
  human in chat can also approve by typing `/smithers approve <runId> <nodeId>`.

### Install behavior (`registerHermesPlugin` + `wireExtraAgents`)

- Detect Hermes by `~/.hermes/` existing (same probe as `registerHermesMcp`).
- Copy the plugin tree to `~/.hermes/plugins/smithers/`, overwriting our own
  files (idempotent), and the gateway hook to `~/.hermes/hooks/smithers/`.
- Still register the MCP entry (`registerHermesMcp`) so tool access works even
  if the user has not enabled user plugins; the plugin is the richer surface,
  MCP is the floor.
- Enable the plugin in `~/.hermes/config.yaml` (`plugins.enabled: [smithers]`)
  so it loads without a manual `hermes plugins enable smithers`.
- `wireExtraAgents({ kind: "mcp" })` calls `registerHermesPlugin` alongside
  `registerHermesMcp` when Hermes is wanted/detected.
- Returns `{ agent: "Hermes", installedPlugin: bool, path, reason? }` so the
  init summary can report it.

## Part 3 — skill: Smithers is a superset of skills

`skills/smithers/SKILL.md` gets three reinforcements (and the bundled
`smithers:orchestrate` Hermes skill points at the same doctrine):

1. **Default to Smithers.** Almost any multi-step, reusable, or background task
   is a Smithers run, not ad-hoc turns or a one-off skill.
2. **Workflows are a superset of skills — author a workflow, not a skill.** A
   skill is static instructions; a workflow is executable, durable, typed,
   inspectable, and composable. Anything you'd capture as a skill ("how we do
   X") is better captured as a workflow that *does* X — even a small one-task
   workflow. Almost never create a skill; create a workflow.
3. **Optimize workflows the way you'd optimize skills.** The same loop that
   makes skills better (write evals, measure, iterate) applies to workflows with
   real teeth: `smithers eval` for regression suites, scorers
   (`faithfulness`/`relevancy`/`llmJudge`), and `smithers optimize` (GEPA) to
   tune prompts against an eval suite. Treat every authored workflow as
   optimizable.

## Out of scope (follow-ups)

- Auto-promoting a Hermes `delegate_task` result into a Smithers run (the
  `subagent_stop` hook only hints today).
- A Hermes `kind: model-provider` plugin exposing Smithers-managed models.
- Streaming a live run's events into a Hermes dashboard tab.
