---
title: "The command surface"
description: "How one executable answers in three modes, why the shipped verb list and the removed verb list are both closed, and where the canonical per-verb reference lives."
sidebar:
  order: 1
---

`smthrs` is one executable with a closed surface in both directions. It names
every verb that ships and every verb that was removed, so a script written
against Smithers 0.x is told what happened to each spelling instead of getting
a parser error.

## Three modes, decided before parsing

`src/bin.ts` inspects the raw argument vector before it builds anything:

1. **A document.** If the first flag is `--help` or `--version`, the command
   tree renders the document and nothing else runs. No project is resolved, no
   flow directory is scanned, no database is opened. That scan stops at the
   first flag that is not one of the two, because a value spelled `--help` is a
   value, not a request for help.
2. **A refusal.** `Unsupported.refusal(argv)` recognises a removed 0.x verb and
   fails with one sentence and exit 1. Refusing here, rather than from a hidden
   command, is what keeps a refusal from creating `.flows/` and opening two
   databases on its way to saying the verb is gone.
3. **The MCP server.** `--mcp` is a mode, not a verb, because every MCP client
   configures a launch command rather than a subcommand. `McpServer.serve`
   then talks to the same `Control` layer the verbs do.

Anything else runs the command tree. Even then the durable layer belongs to
the handler the parse selects, not to the program: `Command.provide` builds
`NodeControl.layer` inside the chosen handler, so a typo, an unknown flag, or a
missing argument stays file-free.

## The shipped list

`Verb.shipped` is the catalog. Every entry carries its `--help` line, its
aliases, and the reserved `system/` flow id when the control catalog reserves
one. `Verb.subcommands` is the same list minus `completions`, which
`effect/unstable/cli` provides as the global `--completions <shell>` flag
rather than as a subcommand.

The contract is that a verb either ships with a handler or is removed and says
so. A verb that appears in neither list, or in both, fails
`packages/smithers/test/Verb.test.ts`.

Six aliases survive, and all six are hidden from `--help` so the help document
shows the canonical surface only:

| Alias | Canonical form |
| --- | --- |
| `resume <run-id>` | `run --resume <run-id>` |
| `workflow list` | `ls` |
| `inspect`, `why` | `status` |
| `events` | `logs --json` |
| `gateway` | `serve` |

## The global flags

Every verb accepts the shared flag set, declared once on the root command:

| Flag | Value | Meaning |
| --- | --- | --- |
| `--root` | path | The project to act on, instead of walking up from the working directory. |
| `--remote` | URL | The control plane to act on. Falls back to `SMITHERS_REMOTE`. |
| `--credential` | token | Bearer token for that control plane. Falls back to `SMITHERS_API_KEY`. |
| `--json` | none | Print the machine document instead of the human rendering. |
| `--quiet` | none | Suppress what the command writes. |
| `--mcp-config` | path | The JSON array of MCP servers the local executor projects into a run's flow catalog. |
| `--backend` | name | Hidden. `sqlite` is a no-op; any other value exits 1. |

`effect/unstable/cli` adds `--help`, `--version`, `--wizard`,
`--completions <shell>`, and `--log-level <level>`.

`--root`, `--remote`, `--credential`, and `--mcp-config` are read from raw argv
by `NodeControl.makeConfig` before the parser runs, because the durable layers
are built from them. They are declared on the command tree as well so the
parser accepts them.

`--quiet` currently suppresses the stdout document as well as the stderr
banners its own description names, because `Command.ts` skips the
`Console.log` when it is set. Do not use it on a command whose document you
intend to read.

## The removed list

`Unsupported.removedVerbs` names every 0.x verb that is gone, with the group
it belonged to and the reason, and `Unsupported.removedFlags` does the same for
flags. Each refusal is one sentence and a link into the migration page's anchor
for that name, never a usage error:

```text
smthrs replay was removed in 1.0.0-rc.0: time travel is a library API
(@smthrs/time-travel) and worktree lanes are deferred.
See https://smithers.sh/migration/1.0#replay
```

Three refusals behave slightly differently, and each is deliberate:

- `gateway` survives as the `serve` alias, so only `gateway status` and
  `gateway stop` refuse. It is registered as a command group rather than an
  alias because an alias has no subcommands, and `gateway status` would
  otherwise reach the parser as a stray positional argument.
- `workflow list` survives as the `ls` alias, so only the other `workflow`
  subcommands refuse.
- `--backend sqlite` names the one backend that ships and is accepted as a
  no-op. Any other value, from the flag or from `SMITHERS_BACKEND`, exits 1
  with `unsupported_database`. `Environment.unsupportedBackend` owns that
  distinction.

A flow id beginning with `system/` is refused the same way.
`Unsupported.isReservedFlow` is the test: the control catalog reserves those
ids for command-line verbs, and 1.0.0-rc.0 ships a body for none of them, so a
launch would park with nothing to run.

## Where the per-verb reference lives

The canonical reference for each verb, with its arguments, flags, output, exit
codes, and captured `--help`, is on smithers.sh under `/cli/<verb>`: for
example [`smthrs plan`](/cli/plan), [`smthrs run`](/cli/run), and
[`smthrs up`](/cli/up). Those pages are generated from the real parser and the
release policy by `apps/site/scripts/gen-cli-data.mjs`, so they cannot drift
from the binary.

This package also carries source-generated reference pages for three verbs
under `reference/cli/`. See
[the CLI reference index](../reference/cli/README.md) for what those pages are
for and which source wins when the two disagree.
