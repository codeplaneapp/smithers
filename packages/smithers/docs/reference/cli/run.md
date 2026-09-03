---
title: "smithers run"
description: "Run an approved plan payload, or resume a parked run"
area: cli
order: 10
---

## Synopsis

```text
smithers run PLAN_PAYLOAD
smithers run --resume RUN_ID
```

## Description

`smithers run` submits the serialized approval payload that `smithers plan`
printed and prints the control receipt. `Verb.ts` records `resume` as an
alternate spelling, and the command tree registers it as a hidden
`smithers resume RUN_ID` that runs the same handler as `smithers run --resume`.

The command plans nothing and approves nothing. A payload whose target is not a
plan is rejected, and a plan that carries no approval grant parks instead of
launching: the receipt reads `Parked` and the process exits 3.

When this process owns the executor, `smithers run` stays attached after the
receipt is accepted and waits for the run to settle, then reports the run's
outcome as its own exit status. A `--remote` composition owns no executor, so
it prints the receipt and returns without waiting.

## Arguments

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| `PLAN_PAYLOAD` | `string` | Yes | The serialized approval payload, the `approval` member of a plan card. With `--resume`, the same position carries the run id instead. |

## Flags

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `--resume` | `boolean` | `false` | Read the argument as a run id and resume that run rather than launching a payload. |

## Global flags

`smithers run` accepts `--root`, `--remote`, `--credential`, `--json`,
`--quiet`, `--mcp-config`, and `--log-level`, listed in the
[CLI reference index](/docs/reference/cli/).

## Output

`smithers run` prints one control receipt on stdout. Object members are ordered
by UTF-16 code unit, the human rendering indents two spaces per level, and
`--json` prints the same document with no whitespace. The receipt is one of
five tagged shapes: `Accepted` with `receiptId` and `runId`, `AlreadyApplied`
with the same two members, `Parked` with `receiptId`, `planId`, and
`status: "waiting-approval"`, `Conflict` with `message`, or `Terminal` with
`runId` and `status`.

The receipt is printed before the settlement wait reports anything, so a caller
reads `runId` from the document whatever the run then does.

When the executor declines an accepted run, the command prints the run summary
and then fails with a sentence that names the run, its status, and
`smithers cancel <run-id>` as the way to end it.

`--quiet` suppresses the document itself, not only the stderr notices its own
description names.
<!-- verify: --quiet is described as "Drop the banners and notices commands write to stderr", but Command.ts `render` skips the stdout Console.log when it is set. Which is the intended contract? -->

## Exit codes

| Code | When |
| --- | --- |
| `0` | The receipt was `Accepted` or `AlreadyApplied` and, when this process waited, the run settled `completed`. |
| `1` | The run settled `failed`, the receipt was `Conflict` or `Terminal` with status `failed`, the executor declined the accepted run, `--backend` or `SMITHERS_BACKEND` named a backend other than `sqlite`, or the control plane refused the mutation (run or plan not found, plan denied, digest or envelope mismatch, claim lost, launch failed, persistence failure, unavailable). |
| `2` | The payload is not valid JSON, does not match the approval schema, or targets a node rather than a plan (`run requires a plan approval payload`); or the command line failed to parse. |
| `3` | The receipt was `Parked`, or the run settled at `waiting-approval`. |
| `130` | The run settled `cancelled`, the receipt was `Terminal` with status `cancelled`, or the process received `SIGINT`. |
| `143` | The process received `SIGTERM`. |

## Example

Launch a plan payload that `smithers approve` has already granted:

```bash
approval="$(smithers --json plan deploy/status | jq -c '.approval')"
smithers --json approve "$approval" --scope run
smithers --json run "$approval"
```

The accepted receipt, with the identifier placeholders that
`packages/smithers/test/fixtures/json-receipts.json` pins the document against:

```text
{"_tag":"Accepted","receiptId":"<receipt-id>","runId":"<run-id>"}
```

## See also

- [`smithers plan`](/docs/reference/cli/plan/) produces the payload this
  command takes.
- [`smithers approve`](/docs/reference/cli/approve/) grants the payload so a
  submission launches instead of parking.
- [`smithers up`](/docs/reference/cli/up/) performs plan, approve, and run in
  one call.
- [`smithers ps`](/docs/reference/cli/ps/) lists the run this command started.
- [Plan, approve, run](/docs/guides/plan-approve-run/) shows the procedure.

## Sources

- `packages/smithers/src/Verb.ts`
- `packages/smithers/src/Command.ts`
- `packages/smithers/src/CliError.ts`
- `packages/smithers/src/Output.ts`
- `packages/smithers/src/ExecutorOwnership.ts`
- `packages/smithers/src/Application.ts`
- `packages/smithers/src/NodeControl.ts`
- `packages/smithers/src/bin.ts`
- `packages/smithers/control/src/Control.ts`
- `packages/smithers/control/src/ControlSchema.ts`
- `packages/smithers/test/Golden.test.ts`
- `packages/smithers/test/fixtures/json-receipts.json`
- `packages/smithers/README.md`
- `apps/site/src/data/help/run.txt`
