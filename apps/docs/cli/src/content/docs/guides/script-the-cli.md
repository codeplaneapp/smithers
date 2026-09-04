---
title: "Script the CLI"
description: "Drive smthrs from a shell script or a CI job: read --json documents, branch on exit codes, and retry a command without duplicating its effect."
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/docs/guides/script-the-cli.md"
---

Write a script against three things the CLI promises: one document on stdout,
one status vocabulary, and an idempotency key per mutation. Nothing else about
the output is stable.

## Read the document, not the prose

Pass `--json` and parse stdout. The human rendering is the same document with
indentation, so both carry the same members in the same order, but only the
compact form is meant for a parser.

```bash
plan="$(smthrs --json plan deploy/status branch=main)"
approval="$(printf '%s' "$plan" | jq -c '.approval')"
```

stdout carries the document alone. Notices, banners, and the failure sentence
all go to stderr, so a parse never trips over a diagnostic. Redirect stderr
when you want it:

```bash
smthrs --json ps 2>/dev/null
```

Add `--quiet` when banners or progress on stderr are unwanted. It never
suppresses the stdout document, so `smthrs --json --quiet ps` remains valid
input to a JSON parser.

## Branch on the status

```bash
smthrs run "$approval" --json
case $? in
  0)   echo "run completed" ;;
  1)   echo "run failed, or the command did"; exit 1 ;;
  2)   echo "the command line is wrong"; exit 2 ;;
  3)   echo "parked at waiting-approval" ;;
  130) echo "cancelled or interrupted" ;;
  143) echo "terminated" ;;
esac
```

Status 3 is the one outcome the payload alone cannot tell you: the run did not
fail, it is waiting for a decision. Status 2 is the one that means retyping the
command can help.

The statuses that report a run outcome, rather than a failure of the command,
are decided from the control receipt. That only happens when this process owns
the executor, which a local composition does and a `--remote` client does not.
See [Local and remote control planes](/concepts/local-and-remote/).

## Answer a park

Exit 3 happens two ways, and the receipt tells them apart.

A `Parked` receipt means the plan itself carries no grant. Approve the same
payload you submitted, and `approve` launches it:

```bash
receipt="$(smthrs --json run "$approval")"
if [ "$(printf '%s' "$receipt" | jq -r '._tag')" = "Parked" ]; then
  smthrs --json approve "$approval" --scope run
fi
```

An `Accepted` receipt with exit 3 means the run started and then parked on an
in-run ask. The run journals a `control.approval.requested` event whose
`payload` member is the exact argument for `smthrs approve`:

```bash
run_id="$(printf '%s' "$receipt" | jq -r '.runId')"
ask="$(smthrs --json logs "$run_id" \
  | jq -c 'map(select(.kind == "control.approval.requested")) | last | .payload')"
smthrs --json approve "$ask" --scope once
smthrs --json run --resume "$run_id"
```

`--scope` decides how far the grant reaches: `once` answers this ask alone,
`run` covers the whole run, and `remembered` covers every later run. The CLI
defaults to `run`, matching what `smthrs up` grants itself. The MCP
`resolve_approval` tool defaults to `once` instead, because an argument a
client never sent must not widen what it may do.

`smthrs status <run-id>` prints both commands on its `Unblock` line when a run
is parked, already quoted for a shell.

## Retry safely

Every mutation the CLI sends carries an idempotency key, so re-running a
command that already took effect replays the recorded receipt instead of
performing the operation twice.

| Verb | Key |
| --- | --- |
| `cancel` | `cli:cancel:<run-id>` |
| `signal` | `cli:signal:<run-id>:<payload digest>` |
| `steer` | `cli:steer:<run-id>:<uuid>` |
| `approve`, `deny` | The `idempotencyKey` member of the payload you pass |

`signal` includes the payload digest because two different signals to one run
are two mutations. Sending the identical payload twice replays the first
receipt; sending a different one delivers a second signal.

`steer` mints a fresh key per invocation, so two identical steering messages
are two messages.

## Wait for a run without polling

```bash
smthrs logs "$run_id" --follow
```

Follow mode streams one line per event as it lands, and applies the per-event
1 MiB cap without retaining prior events. A finite read (`smthrs logs
<run-id>`) retains at most 50,000 events and 16 MiB and fails with a typed
resource-limit error rather than truncating.

Attached `run`, `up`, `approve`, and `deny` already wait for settlement when
this process owns the executor, so a script that runs a flow to completion
needs no polling at all.

## In CI

- Set `CI=true`. `Ui.isInteractive` is false whenever `CI` is `"true"`, either
  stream is not a terminal, or `TERM` is `dumb`, so every interactive rendering
  falls back to plain lines.
- Pass `--root` explicitly when the job's working directory is not the project
  root, rather than relying on the upward walk.
- Run `smthrs doctor` as a first step. It runs nothing, exits 1 on a blocking
  problem, and its `--json` report is one object with a `root` and a `checks`
  array.
- Use `smthrs down` in an always-run step to cancel everything a failed job
  left non-terminal, and `smthrs gc --older-than <duration>` to bound how much
  the databases keep.

## See also

- [Output and exit codes](/concepts/output-and-exit-codes/): what makes a
  rendering deterministic, and what refuses.
- [Launch a detached run](/guides/launch-a-detached-run/): starting a run that
  outlives the script.
- [Diagnose a run](/guides/diagnose-a-run/): reading back what a run did.
