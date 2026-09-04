---
title: "Contain spawned processes"
description: "Compose ContainedSpawner and ProcessLedger so a cancelled run kills its children on a deadline and a crashed host leaves records its successor can reap."
sidebar:
  order: 6
---

Without containment, a spawned child that ignores `SIGTERM` hangs a
cancellation forever, and a host that crashes abandons every process it
started. This guide wires the two pieces that fix both.

## Compose the spawner over the ledger

`ContainedSpawner.layer` requires `ChildProcessSpawner` (which it also
provides) and `ProcessLedger`:

```ts
import { ContainedSpawner, ProcessLedger } from "@smthrs/kernel"
import { Layer } from "effect"

const contained = ContainedSpawner.layer({ graceMs: 2000, platform: process.platform }).pipe(
  Layer.provide(rawSpawner),
  Layer.provideMerge(ProcessLedger.layer({ hostId: "my-host", ownerPid: process.pid }))
)
```

`graceMs` is the interval between the `SIGTERM` that asks a child to stop and
the `SIGKILL` that makes it. It defaults to `ContainedSpawner.defaultGraceMs`
(2,000 ms).

`platform` decides only one thing: whether a command that names no `detached`
option gets a process group of its own. It defaults to `"linux"`, the detaching
branch. Pass `process.platform` on a real host, because a win32 record claiming
`pgid === pid` would name a group the child does not lead.

The kernel's permission decorator and this one both provide the tag they
require, so they stack in either order over one host implementation.

## Choose a ledger

```ts
// Durable: inherits a crashed incarnation's processes. Requires a `Journal`.
ProcessLedger.layer({ hostId, ownerPid })

// In-memory: contains this incarnation and inherits nothing. No journal.
ProcessLedger.layerMemory({ hostId, ownerPid })
```

The durable half is only as good as the journal underneath it, so the choice
belongs to the program that knows which it has. `hostId` names the run the
records live on (`flows.host:<hostId>`), and `ownerPid` is what distinguishes
this incarnation's processes from the orphans a previous one left.

On Node, `@smthrs/platform-node`'s `NodeHost.layerContained` and
`layerContainedAt` compose the spawner, bind `Jj` through it so a stray `jj`
invocation is recorded too, and add the `ProcessReaper` that sweeps inherited
records before handing the host over. You supply the ledger.

## Handle a failed record

`record`, `release`, `reaped`, and `skipped` all carry the journal's failure to
their caller, and the spawner acts on it: a spawn whose durable record fails is
signalled, the call fails, and no pid is left in `ProcessLedger.live`. A child
no incarnation of this host can discover is the one outcome containment exists
to prevent, so do not catch that failure and proceed.

The release finalizer is the exception, because it has nowhere left to report.
A missed release leaves the record inherited, and the next reaper finds the pid
already gone and retires it.

## Read what is running and what was abandoned

```ts
const ledger = yield * ProcessLedger.ProcessLedger

const running = yield * ledger.live // this incarnation's unreleased records
const abandoned = yield * ledger.orphans // records whose owner pid is not ours
```

`orphans` replays the host's journal history, folds the exit, reap, and skip
events onto the spawn events, and returns what is left. A host that wants to
clean them up signals each group and then retires the record:

```ts
yield * ledger.reaped(record) // we signalled it
yield * ledger.skipped(record, "pre-boot") // we refused to, and why
```

Use two different calls deliberately. An operator reading the journal can then
tell "we killed it" from "we declined to", which a single retire event would
erase.

Signalling a process group you did not start is dangerous, because a pid can be
recycled. Before reaping, verify that the record names a separate process group
rather than your own, that the owner is gone, that the record belongs to the
current boot, and, where the platform can read it, that the pid's start time
still matches. `@smthrs/platform-node`'s `ProcessReaper` implements exactly
those checks; reuse it rather than writing the comparisons again.

## Related

- [Process containment](../concepts/process-containment.md): why each of these
  pieces exists.
- [Guard a host bundle](./guard-a-host-bundle.md): containment inside the full
  host composition.
