---
title: "The owner fence"
description: "Why the durable channel takes an OwnerId, what makes a write fail with fence_lost, and when the unfenced channel is the correct one."
sidebar:
  order: 2
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/journal/docs/concepts/owner-fence.md"
---

A run can outlive the process that claimed it. A machine pauses, a supervisor
declares the run abandoned, another process takes it over, and then the first
process wakes up holding a half-finished lifecycle write. Without a fence, that
zombie write lands behind the live successor and the run's history says two
processes were driving it.

The journal refuses that write. `emitDurable`, `checkpoint`, and `compact` each
take an `OwnerId`, and each lands only while the run still records that owner.

## The token

`OwnerId.OwnerId` is three fields:

```ts
import type * as OwnerId from "@smthrs/journal/OwnerId"

const owner: OwnerId.OwnerId = {
  hostId: "host-1",
  pid: process.pid,
  nonce: "run-1-claim"
}
```

`hostId` and `nonce` are plain strings. `pid` is a real operating-system
process id, so the schema states that: a non-negative integer.

The token lives in this package rather than with the ownership arbitration in
[`@smthrs/run-store`](https://run-store.smithers.sh/reference/api/) because the journal is what it fences.
The run store stores the token on runs and decides who holds it, and its
`Ownership` module re-exports `OwnerId` alongside that arbitration.

## What the fence actually checks

A fenced write carries its own predicate. The insert lands only when
`flows_runs` holds a row for the run whose `status` is `running` and whose
three owner columns equal the supplied token. The predicate travels in the
write statement, so the check and the write cannot be separated by a race.

Two consequences follow:

- A run that another process reclaimed fails the write with `fence_lost`.
- A run that is no longer `running` fails the same way, whatever moved it.
  A finished run does not accept late lifecycle writes.

`flows_runs` belongs to `@smthrs/run-store`, so a fenced write reads a table
this package does not own. That coupling is deliberate and pinned by tests on
both sides: `test/JournalFence.test.ts` here asserts against a fixture of the
columns the fence reads, and `@smthrs/engine-store` asserts the same behavior
against the real migrated schema.

If the table is absent entirely, the write fails `sink_failed` with
`no such table: flows_runs`, not `fence_lost`. That is a composition problem;
see [Installation](/installation/#what-a-fenced-write-needs).

## A bad token is not a lost fence

An owner that is missing, null, or not an `OwnerId` at all fails
`invalid_event`. That is a caller contract violation, and reporting it as
`fence_lost` would send the caller hunting a race that never happened. A
fractional or negative `pid` is the common case.

Read the two codes as different questions:

- `fence_lost` asks who owns this run now. Stop writing.
- `invalid_event` asks what you passed. Fix the argument.

## The unfenced escape

`emitDurableUnfenced` is the same durability and the same receipt contract with
no fence. It exists for admissions that are genuinely ownerless, where
first-writer-wins is the design rather than an accident. The canonical case is
an external trigger: a deferred completion or a clock-schedule record delivered
by a sweeper that owns no run, where the producer dedup index rather than the
fence is the idempotency mechanism.

A caller that holds an `OwnerId` uses `emitDurable`. Reaching for the unfenced
channel to get past a `fence_lost` writes exactly the zombie entry the fence
exists to reject.

## Related reading

- [Write a fenced lifecycle event](/guides/write-lifecycle-events/) is the
  task-shaped version of this page.
- [Execution IDs and ownership](https://smithers.sh/docs/concepts/ownership/) covers how a run
  acquires and loses the token in the first place.
