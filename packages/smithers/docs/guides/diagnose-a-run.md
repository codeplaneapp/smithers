---
title: "Diagnose a run"
description: "Work out why a run stopped: check the machine with doctor, read the status card, follow the transcript, print a node output, and file a bug with the digest attached."
---

Four commands answer four different questions, and none of them opens a
database directly. Every read goes through the control plane, so a `--remote`
invocation renders exactly what a local one renders.

## Is the machine ready?

```bash
smthrs doctor
```

`doctor` runs nothing. It reports the project root it resolved, how many flows
the registry discovered and one line per discovery warning, both database files
with how many migrations each has recorded, the running Node against the
22.19.0 floor, whether `jj` is executable, which of `ANTHROPIC_API_KEY`,
`OPENAI_API_KEY`, `OPENROUTER_API_KEY`, and `CEREBRAS_API_KEY` are set, and any
Smithers 0.x state beside the project.

Each check is `ok`, `warn`, or `fail`. A `warn` is a fact you should know that
stops nothing. A `fail` is a fact that will stop the next command you run, and
one `fail` makes `doctor` itself exit 1.

`--json` prints the report verbatim: an object with `root` and a `checks` array
of `{ name, level, detail }`. On a terminal the human rendering adds symbols
and a verdict line; on a pipe it is one line per check.

Reach for `doctor` when a flow discovers nothing, when a command wrote to a
database you did not expect, or when a launch is refused for a missing
credential.

## What happened to this run?

```bash
smthrs status <run-id>
```

The status card is the diagnosis, computed from the run's journal events alone:

```text
Verdict   failed: Set OPENAI_API_KEY to run the openai:gpt-5.6-sol seat
Run       run-1 · hello · 0s
Activity  0 turns · 0 calls (0 refused, 0 duplicate) · edits 0/0
Tokens    0 in / 0 out
Cause     Set OPENAI_API_KEY to run the openai:gpt-5.6-sol seat
Next      smthrs logs run-1    # turn-by-turn transcript
```

Lines appear only when they have something to say. A run with refused flow
calls gains a `Refusals` line, aggregated by message with a count, which is
usually where a stuck agent's real problem is. A run that is still waiting
gains an `Unblock` line, and that line is the point of the card. It carries
the exact command that ends the wait, already quoted for a shell:

- A run parked on an approval gets the `smthrs approve '<payload>' --scope run`
  and `smthrs run --resume <run-id>` pair.
- A run no executor took, which `ps` lists as `accepted` with
  `waitingReason: "executor"` and the card calls `pending`, gets
  `smthrs cancel <run-id>` and a note that the alternative is to run the flow
  from the host program that registers its delegates.

`smthrs inspect` and `smthrs why` are aliases of the same verb. With no run id,
`status` prints the run listing instead.

## What did it do, step by step?

```bash
smthrs logs <run-id>              # the transcript
smthrs logs <run-id> --json       # the raw event stream
smthrs logs <run-id> --follow     # one line per event as it lands
smthrs events <run-id>            # alias of logs --json
```

The human rendering is a turn-by-turn transcript, because a transcript needs
the whole run. Follow mode renders one line per event instead, since the run is
still going. `--json` is the raw `ControlEvent` stream in both modes, byte
stable for a script.

A finite read retains at most 50,000 events and 16 MiB, with a 1 MiB cap on any
single event, and fails with a typed resource-limit error rather than
truncating. Follow mode applies the per-event cap without retaining history.

Omit the run id to read every run's events.

## What did a step produce?

```bash
smthrs output <run-id>             # every registered node output
smthrs output <run-id> result      # one node
```

`output` projects the node outputs a run registered. A node id the run does not
have is a usage error naming the run, not an empty document, so a script never
mistakes "no such node" for "no output".

Node outputs are caller-controlled data, so they are rendered through
`Output.renderValue`. That means a stored value shaped like a control receipt
cannot change the command's exit status.

## Report it

```bash
smthrs bug "up hangs after the second turn" --run <run-id>
```

`bug` collects the context a maintainer always asks for: versions, platform,
the runs in this project, and the named run's event digest. Everything it
collects passes through the journal's shared redaction rules before it leaves
the machine, and the report is refused outright if it contains a callable, a
proxy, a `toJSON` member, or a value past the walk limits, because those could
run code while the report is rendered.

Reports go to `https://bug.smithers.sh/api/bugs` unless
`SMITHERS_BUG_ENDPOINT` names another one.

## See also

- [Output and exit codes](../concepts/output-and-exit-codes.md): the status
  each of these commands exits on.
- [Script the CLI](./script-the-cli.md): answering a park from a script.
- [`smthrs status`](/cli/status), [`smthrs logs`](/cli/logs), and
  [`smthrs doctor`](/cli/doctor): the per-verb reference.
