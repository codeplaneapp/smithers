---
description: "Every command the smithers binary offers in 1.0.0-rc.0, with its flags, aliases, and exit codes."
---

# CLI

`smithers` is the command line for the control plane. It plans a flow, takes the
approval decision, runs the plan, and reads back what the run recorded. Every
command talks to the control services in `@smthrs/control`; none of them reads a
database table directly, so the same command works against a local project and
against a remote `smithers serve` with `--remote`.

## Commands

| Command | Summary |
| --- | --- |
| [`smithers approve`](/cli/approve) | Approve the complete serialized approval payload |
| [`smithers bug`](/cli/bug) | Report a bug with a run digest attached |
| [`smithers cancel`](/cli/cancel) | Cancel a durable run |
| [`smithers claude`](/cli/claude) | Claude Code plugin mirror protocol |
| [`smithers deny`](/cli/deny) | Deny the complete serialized approval payload |
| [`smithers docs`](/cli/docs) | Print the bundled documentation; --full prints llms-full.txt |
| [`smithers doctor`](/cli/doctor) | Report registry, database, runtime, and provider readiness |
| [`smithers down`](/cli/down) | Cancel every non-terminal run |
| [`smithers gc`](/cli/gc) | Delete terminal runs older than a threshold, with the rows they own |
| [`smithers init`](/cli/init) | Scaffold flows/&lt;name&gt;/flow.mdx and ignore .flows/ |
| [`smithers logs`](/cli/logs) | Read run events; --follow streams future events |
| [`smithers ls`](/cli/ls) | List the flows discovered under this project |
| [`smithers mcp`](/cli/mcp) | Wire the Smithers MCP server into an agent |
| [`smithers memory`](/cli/memory) | Read and write namespaced facts in the control database |
| [`smithers migrate`](/cli/migrate) | Convert a Smithers 0.x project to the 1.0 authoring model |
| [`smithers output`](/cli/output) | Print one registered node output |
| [`smithers plan`](/cli/plan) | Render a flow plan and its complete approval payload |
| [`smithers ps`](/cli/ps) | List durable runs |
| [`smithers run`](/cli/run) | Run an approved plan payload, or resume a parked run |
| [`smithers serve`](/cli/serve) | Host the control server for this project |
| [`smithers signal`](/cli/signal) | Deliver a durable JSON signal to a run |
| [`smithers skills`](/cli/skills) | Install and list the smithers agent skill |
| [`smithers status`](/cli/status) | Show the diagnosis card for one run, or the run listing |
| [`smithers steer`](/cli/steer) | Send a durable, attributed steering message to a run |
| [`smithers up`](/cli/up) | Plan, approve, and run one flow; -d launches it detached |
| [`smithers update`](/cli/update) | Check npm for a newer @smthrs/cli |

## Aliases

| Alias | Command |
| --- | --- |
| `smithers events` | [`smithers logs`](/cli/logs) |
| `smithers gateway` | [`smithers serve`](/cli/serve) |
| `smithers inspect` | [`smithers status`](/cli/status) |
| `smithers resume` | [`smithers run`](/cli/run) |
| `smithers why` | [`smithers status`](/cli/status) |
| `smithers workflow list` | [`smithers ls`](/cli/ls) |

## Global flags

| Flag | Meaning |
| --- | --- |
| `--credential string` | Bearer token for the remote control plane; falls back to SMITHERS_API_KEY |
| `--json` | Print the machine-readable document instead of the human rendering |
| `--remote string` | http(s) URL of the control plane to act on; falls back to SMITHERS_REMOTE |
| `--quiet` | Drop the banners and notices commands write to stderr |
| `--mcp-config string` | Path to the JSON array of MCP servers the local executor projects into a run's flow catalog |
| `--root string` | Project root to act on, instead of walking up from the working directory |
| `--help, -h` | Show help information |
| `--version, -v` | Show version information |
| `--wizard` | Start wizard mode for a command |
| `--completions &lt;bash\|zsh\|fish\|sh&gt;` | Print shell completion script (choices: bash, zsh, fish, sh) |
| `--log-level &lt;all\|trace\|debug\|info\|warn\|warning\|error\|fatal\|none&gt;` | Sets the minimum log level (choices: all, trace, debug, info, warn, warning, error, fatal, none) |

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | success |
| 1 | unsupported or generic error |
| 2 | usage |
| 3 | parked (`waiting-approval`) |
| 130 | SIGINT |
| 143 | SIGTERM |

## Removed commands

Smithers 1.0.0-rc.0 removed the 0.x verbs that depended on the JSX runtime, the
old gateway, or a deferred feature. Each one exits 1 with a message naming what
to use instead; the [migration guide](/migration/1.0#removed-commands) lists every
verb and its replacement.

## Source

This page is generated from the binary's `--help` output and section 4 of the
[release contract](https://github.com/smithersai/smithers/blob/main/docs/migration/rc-contract.md).
Run `pnpm docs:pages` after changing either.
