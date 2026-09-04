---
title: "@smthrs/cli"
description: "The smthrs command line: the Node projection of the Smithers control plane, and the library that composes it."
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/docs/README.md"
---

`@smthrs/cli` is the `smthrs` command line, and the library that assembles it.

The package ships one executable under two names, `smthrs` and its `smithers`
alias, that plans, approves, runs, and inspects durable flows. Every handler
talks to the `Control` service and to nothing else, so the same verb answers
the same way against a local project and against a `--remote` control plane.
The library half of the package is the composition that executable is built
from: the command tree, the Node layer that satisfies it, the deterministic
output service, and the terminal renderer.

## Who uses this package

Operators install it to run flows from a shell. Scripts and CI jobs call it
with `--json` and branch on its exit codes. Agents drive the same control
plane through `smthrs --mcp`, the stdio MCP server the executable also hosts.
Hosts that embed Smithers import `Command.cli` and `NodeControl.layer` and run
the command tree inside a program of their own.

## Install

```bash
npm install --global @smthrs/cli@next
```

Node 22.19.0 or later is required. For the runner matrix, the source-checkout
path, and what a project directory needs, see [Installation](/installation/).

## The shortest real example

Scaffold a flow, plan it, approve the plan, and run it:

```bash
smthrs init hello
smthrs ls
approval="$(smthrs --json plan hello | jq -c '.approval')"
smthrs --json approve "$approval" --scope run
smthrs --json run "$approval"
smthrs ps
```

`smthrs plan` creates no run. It prints a plan card whose `approval` member is
the payload `approve`, `deny`, and `run` accept unchanged, which is why the
same string appears twice above. `smthrs up hello` collapses all three steps
into one verb. [Quickstart](/quickstart/) walks the loop to a settled run
and reads its events back.

## The binary at a glance

One executable answers in three modes, chosen before the command tree parses
anything:

| Invocation | What it does |
| --- | --- |
| `smthrs --help`, `smthrs --version` | Prints a document. Resolves no project, opens no database. |
| `smthrs --mcp` | Serves the Smithers MCP server on stdio over the same control plane the verbs use. |
| `smthrs <verb> ...` | Runs one command handler against the `Control` service. |

The verbs group by the job they do:

| Job | Verbs |
| --- | --- |
| Plan and launch | `plan`, `run` (alias `resume`), `up` |
| Decide an approval | `approve`, `deny` |
| Steer a live run | `signal`, `steer` |
| End a run | `cancel`, `down` |
| Read what happened | `ls`, `ps`, `status` (aliases `inspect`, `why`), `logs` (alias `events`), `output` |
| Set a project up | `init`, `suggest`, `doctor`, `migrate` |
| Host and integrate | `serve` (alias `gateway`), `mcp`, `claude` |
| Maintain | `gc`, `memory`, `update`, `bug`, `completions` |

`Verb.shipped` is the authority for that list, and
`Unsupported.removedVerbs` is the authority for the Smithers 0.x spellings
that now refuse with a migration link. The per-verb reference, with arguments,
flags, output, and exit codes for each one, lives on smithers.sh: start at
[`smthrs plan`](https://smithers.sh/docs/reference/cli/plan/). See [The command surface](/concepts/command-surface/)
for how the two lists are kept honest, and
[the CLI reference index](/reference/cli/) for which pages are
canonical.

## The package at a glance

The root entry point exports every module as a namespace, and each is also
importable from `@smthrs/cli/<Module>`:

| Namespace | What it is |
| --- | --- |
| `Command` | The Effect CLI command tree: every shipped verb with a handler, every removed one with a refusal. |
| `NodeControl` | The complete Node host for that tree: configuration, registry, durable engine, executor, output, and the served gateway. |
| `Application` | The transport-neutral half of that composition: local `Control` or the RPC client, chosen from `Config`. |
| `Output` | Deterministic rendering, and the receipt-to-exit-code mapping. |
| `Ui` | Interactive terminal rendering, with a plain-line fallback for pipes and CI. |
| `CliError` | The four failures the projection adds, and the status each exits on. |
| `Verb`, `Unsupported` | The shipped verb catalog, and the removed verbs, flags, and reserved flow ids. |
| `Project`, `Environment` | Where an invocation decides it is running, and the closed set of variables it reads. |
| `Detached` | The `up -d` launch, and the admission line its child prints. |
| `Doctor`, `Forensics`, `NodeOutput`, `Legacy` | Readiness, run diagnosis, node outputs, and the 0.x database guard. |
| `McpServer`, `Agents` | The stdio MCP server, and the agent configurations `mcp add` writes it into. |
| `Serve` | The gateway bind rule, the mount list, and the banner rendered from it. |
| `Init`, `Suggest`, `Providers` | Scaffolding, the guided suggestion pass, and the seats this machine can run. |
| `Gc`, `Update`, `Bug`, `ClaudeMirror`, `CodexAuth`, `ExecutorOwnership`, `Version` | Retention, version checks, bug reports, the Claude Code mirror protocol, the Codex credential store, executor ownership, and the installed version. |

Every export of every namespace is on the [API reference](/reference/api/).

## Where to go next

- [Installation](/installation/): requirements, executables, and the two run paths.
- [Quickstart](/quickstart/): one project from `init` to a settled run.
- Concepts: [the command surface](/concepts/command-surface/),
  [the project and its state](/concepts/project-and-state/),
  [local and remote control planes](/concepts/local-and-remote/), and
  [output and exit codes](/concepts/output-and-exit-codes/).
- Guides: [script the CLI](/guides/script-the-cli/),
  [launch a detached run](/guides/launch-a-detached-run/),
  [diagnose a run](/guides/diagnose-a-run/),
  [serve the workspace gateway](/guides/serve-the-workspace-gateway/),
  [wire the MCP server into an agent](/guides/wire-the-mcp-server/), and
  [embed the command tree](/guides/embed-the-command-tree/).
- [Troubleshooting](/troubleshooting/): the refusals this CLI prints, and
  what to change.
