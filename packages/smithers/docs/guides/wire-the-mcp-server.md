---
title: "Wire the MCP server into an agent"
description: "Register smthrs --mcp with Claude Code or Codex, scope the tool list a session sees, and know which 0.x tools answer unsupported."
---

`smthrs --mcp` serves the Smithers MCP server on stdio, over the same control
plane the verbs use. An agent that speaks MCP can list flows, watch runs, and
inspect pending approvals without shelling out.

## Register it

```bash
smthrs mcp add --agent claude
smthrs mcp add --agent codex
smthrs mcp add                  # every agent it knows
```

`--agent` is a flag, not a positional argument. `mcp add` writes an
`mcpServers` entry named `smithers` into the agent's own configuration:

| Agent | File |
| --- | --- |
| `claude` | `~/.claude.json` |
| `codex` | `~/.codex/mcp.json` |

`smthrs mcp add` with no `--agent` wires every agent it knows. An unknown agent
name is a usage error that lists the known ids. `smthrs mcp` on its own prints
the group's help; `add` is its only subcommand.

The entry records the current executable and entry path verbatim, not a package
runner. A checkout under development therefore registers the CLI under edit,
and an installed CLI registers its own installed path. Smithers 0.x registered
`bunx smthrs --mcp`, which silently pointed every agent at the last published
build.

The write is a temp-file-plus-rename under a lock file, with the original
file's mode preserved, so a crash mid-write cannot leave a half-written
configuration. If the file already holds the exact entry, nothing is written
and the result says `unchanged`. If every target fails, the command prints
manual instructions to stderr and exits 1.

## Serve it by hand

```bash
smthrs --mcp
```

`--mcp` is a mode, not a verb, because every MCP client configures a launch
command rather than a subcommand. The flag is read from the raw argument vector
before the command tree parses anything.

Three flags scope one session, and they are read the same way:

| Flag | Effect |
| --- | --- |
| `--surface semantic` | The eleven control-backed tools. The default. |
| `--surface raw` | One directory entry per shipped CLI verb, naming the shell command. |
| `--surface both` | Both lists. |
| `--allowed-tools a,b,c` | Only these tool names. |
| `--read-only` | Only tools that read. |

The raw surface is a directory, not a second execution path. Smithers 0.x
mirrored every CLI command as an MCP tool by reflecting its argument parser,
which made MCP an undocumented copy of the command line. Naming the verbs and
pointing at the semantic tool that performs each one keeps exactly one
execution path.

## The tool surface

Eleven tools reach the control plane: `list_workflows`, `run_workflow`,
`list_runs`, `get_run`, `watch_run`, `get_run_events`, `explain_run`,
`list_pending_approvals`, `resolve_approval`, `get_node_detail`, and
`get_chat_transcript`.

Every tool answers one envelope:

```json
{ "ok": true, "data": {} }
```

```json
{ "ok": false, "error": { "code": "unsupported", "message": "..." } }
```

Ten 0.x tool names are still listed and answer `{ ok: false, error: { code:
"unsupported" } }` with the reason, rather than disappearing:
`revert_attempt`, `fork_run`, `replay_run`, `rewind_run`, `get_timeline`, and
`time_travel` because time travel is a library API in
[`@smthrs/time-travel`](/api/time-travel) that the CLI does not compose;
`restore_checkpoint` and `list_snapshots` because worktree lanes and snapshot
restore are deferred; `list_artifacts` because the artifact projection is not
in this release; and `ask_human` because there is no question RPC at all, so
`list_pending_approvals` is the replacement.

`McpServer.unsupportedTools` and `McpServer.unsupportedReasons` are the
authority for that list.

Reserved `system/*` flows are not listed and cannot be launched, matching
`smthrs up` and `smthrs ls`.

Every MCP mutation is attributed to an `agent` principal. Approval and denial
are operator-only: `resolve_approval` returns `UNAUTHORIZED` at every scope,
including `remembered`. `run_workflow` also returns `UNAUTHORIZED` when it
attempts to approve its plan, and launches no run. Operators use `smthrs up`
to launch a flow and `smthrs approve` or `smthrs deny` to decide an approval.
Read tools, including `list_pending_approvals`, remain available.

## Bounds

One request or response frame is limited to 4 MiB, and an oversized input line
is discarded incrementally before JSON decoding rather than buffered. One
history result is limited to 10,000 events and 1 MiB. Crossing either boundary
returns `RESOURCE_LIMIT` in the envelope.

Failures are redacted before they cross the protocol boundary, and every tool
argument is decoded against the same closed schema the server advertises.

## The other direction

`--mcp-config <path>` is not this feature. It names a JSON array of MCP servers
that the local executor connects at startup and projects into a run's flow
catalog, so a flow can call them. The file is an array of
`{ server, command, args, cwd?, env?, handshakeTimeoutMs?, requestTimeoutMs?,
queueCapacity?, maxFrameBytes? }` entries. A path that is missing, unreadable,
malformed, or wrongly shaped is a usage error naming the flag, never a silent
change to the executor's tool catalog.

It is meaningless under `--remote`, where the executor is not this process's to
configure.

## See also

- [`smthrs mcp`](/cli/mcp): the per-verb reference.
- [MCP setup](/docs/guides/mcp-setup/): the product guide.
- [`@smthrs/mcp`](/api/mcp): the client and the flow projection.
