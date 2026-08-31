---
description: "Plan, approve, run, watch, and read back a flow from the command line."
---

# Running a flow

[Writing a flow](/guides/writing-a-flow) produces a `Flow` in `flows/**`. This
guide runs one, from discovery to output, with the commands in
[the CLI reference](/cli).

## Discover

```bash
smithers ls
```

`ls` lists the flow descriptors under `<project>/flows/**`. A descriptor is a
`flow.ts`, a `flow.mdx`, or a `SKILL.md`. Discovery warnings, such as a file
that declares no flow, are reported by `smithers doctor`.

## Plan

```bash
smithers plan example/Build target=server sourceDigest=sha256:...
```

`plan` compiles the flow with its input and prints two things: a plan card
naming every node it will run, and the complete approval payload. Planning does
no I/O and starts nothing. The plan is a value, so the card you read is the
plan that will run.

Pass structured input with `--data` instead of `key=value` pairs:

```bash
smithers plan example/Build --data '{"target":"server"}'
```

## Approve and run

```bash
smithers approve '<payload>' --scope run
smithers run '<payload>'
```

`approve` takes the serialized payload `plan` printed and records the decision
with the acting principal. `run` launches an approved plan and blocks until the
run settles when the local process owns the executor. A denied plan can never
launch.

One command does all three for the common case:

```bash
smithers up example/Build --data '{"target":"server"}' --json
```

`up` plans, approves with scope `run`, and runs. Under `--json` it prints
`{ runId }`, and its exit code follows the terminal status: 0 for a completed
run, 1 for a failed one, 130 for a cancelled one, and 3 for one parked on an
approval. `run` reports the same statuses, since it is the same attached
launch. Add `-d` to run detached: the CLI spawns the run, logs to
`.flows/logs/<runId>.log`, and returns once the run is admitted — that exit
code is the launch's, not the run's, so a CI step that has to gate on the
result launches attached.

## Watch

```bash
smithers ps
smithers ps --status parked
smithers status RUN_ID
smithers logs RUN_ID --follow
```

`ps` lists runs and filters by flow or status. `status` prints one run's
diagnosis card, which names what the run is waiting for and what it last did;
`inspect` and `why` are aliases. `logs` prints the transcript, `--follow`
streams new events, and `logs --json` prints raw control events. `events` is an
alias of `logs --json`.

## Steer, signal, and decide

```bash
smithers steer RUN_ID --message "prefer the smaller change"
smithers signal RUN_ID '{"name":"approved"}'
smithers approve '<node payload>' --scope once
smithers cancel RUN_ID
```

Steering is durable and attributed: the message goes through the notification
queue and the agent drains it at its next turn close. Signals and approvals wake
a parked run. Cancellation is durable and cross-process. See
[durable waits and control](/concepts/durable-waits).

## Read the result

```bash
smithers output RUN_ID NODE_ID
```

`output` prints one node's registered output from the `node-output` projection.
The projection is a read model over the journal, so reading it never claims the
run.

## Serve the control plane

```bash
smithers serve --host 127.0.0.1 --port 7331
```

`serve` hosts the control server: `/rpc`, `/rpc/ws`, `/sync`, `/sync/ws`,
`/projections/ws`, and `GET /health`. It listens on loopback by default;
binding a non-loopback address requires `--listen` and a bearer token. Point any
command at a served control plane with `--remote` and `--credential`:

```bash
smithers ps --remote https://smithers.internal --credential "$SMITHERS_API_KEY"
```

See [the control plane](/control) for the request surface and
[control-plane trust](/guides/control-plane-trust) for the authorization model.

## Clean up

```bash
smithers gc --older-than 30d --dry-run
```

`gc` deletes terminal runs older than the threshold with their attempts, clock,
deferred, and waiting rows, then compacts the journal. Nothing is deleted
unless you ask: retention is off by default.
