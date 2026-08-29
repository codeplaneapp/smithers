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
| [`smithers approve`](/cli/approve) | Approve the complete serialized plan approval payload |
| [`smithers cancel`](/cli/cancel) | Cancel a durable run |
| [`smithers deny`](/cli/deny) | Deny the complete serialized plan approval payload |
| [`smithers docs`](/cli/docs) | Run the docs system flow |
| [`smithers doctor`](/cli/doctor) | Run the doctor system flow |
| [`smithers init`](/cli/init) | Run the init system flow |
| [`smithers logs`](/cli/logs) | Read run events; --follow streams future events |
| [`smithers ls`](/cli/ls) | List available flows |
| [`smithers migrate`](/cli/migrate) | Run the migrate system flow |
| [`smithers plan`](/cli/plan) | Render a flow plan and its complete approval payload |
| [`smithers ps`](/cli/ps) | List durable runs |
| [`smithers run`](/cli/run) | Run an approved plan payload, or resume a parked run |
| [`smithers serve`](/cli/serve) | Run the serve system flow |
| [`smithers signal`](/cli/signal) | Deliver a durable JSON signal to a run |
| [`smithers status`](/cli/status) | Show control status |
| [`smithers up`](/cli/up) | Boot the local stack; --watch enables development mode |

The binary also registers the reserved system verbs `release`, `replay`, `add`, `remove`, `eject`, `test`. Section 4.2 of the release contract removes them; see the
[migration guide](/migration/1.0#removed-commands).

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
| `--credential string` | See the command pages. |
| `--json` | See the command pages. |
| `--remote string` | See the command pages. |
| `--quiet` | See the command pages. |
| `--mcp-config string` | See the command pages. |
| `--help, -h` | Show help information |
| `--version, -v` | Show version information |
| `--wizard` | Start wizard mode for a command |
| `--completions <bash\|zsh\|fish\|sh>` | Print shell completion script (choices: bash, zsh, fish, sh) |
| `--log-level <all\|trace\|debug\|info\|warn\|warning\|error\|fatal\|none>` | Sets the minimum log level (choices: all, trace, debug, info, warn, warning, error, fatal, none) |

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
