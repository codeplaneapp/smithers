---
description: "Wire the Smithers MCP server into an agent"
---

# smithers mcp

Wire the Smithers MCP server into an agent.

## Usage

```sh
smithers mcp <subcommand> [flags]
```

## Behavior

MCP server over stdio; `{ ok, data?, error? }` envelope kept. Supported tools (11): `list_workflows`, `run_workflow`, `list_runs`, `get_run`, `watch_run`, `get_run_events`, `explain_run`, `list_pending_approvals`, `resolve_approval`, `get_node_detail`, `get_chat_transcript`. Unsupported tools (10) return `{ ok: false, error: { code: "unsupported", ... } }`: `revert_attempt`, `fork_run`, `replay_run`, `rewind_run`, `restore_checkpoint`, `list_snapshots`, `get_timeline`, `time_travel`, `list_artifacts`, `ask_human`.

## Source

This page is generated from the binary's `--help` output and section 4.1 of the
[release contract](https://github.com/smithersai/smithers/blob/main/docs/migration/rc-contract.md).
Run `pnpm docs:pages` after changing either.
