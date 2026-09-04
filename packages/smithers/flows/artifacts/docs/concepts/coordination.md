---
title: "Coordination between processes"
description: "How one objects directory stays safe when several processes write and sweep it: per-digest lock files, heartbeats, the stale-reclaim window, the backup lease, and the fences that hold when the lock does not."
sidebar:
  order: 3
---

An objects directory belongs to a workspace, not to a process. A CLI run, a
gateway, a sandboxed step, and a garbage collector can all be holding the same
`.flows/objects` open at once. Publication is already atomic, so two writers
racing on one digest is harmless. The dangerous overlap is a writer and a
sweeper: one is deduplicating against a blob the other is deleting.

`FileSystemOptions.coordination` and `SweepOptions.coordination` are the dial
for that overlap.

| Mode                 | What it does                                                                                                   |
| -------------------- | -------------------------------------------------------------------------------------------------------------- |
| `required` (default) | An in-process semaphore plus heartbeat-backed lock files under `.locks/`, shared by every cooperating process. |
| `process`            | The in-process semaphore only. The explicit weaker browser and test mode.                                      |

## The lock protocol

Under `required`, a put or a sweep deletion takes the lock file for its digest
before touching the blob:

| Bound                          | Value                          |
| ------------------------------ | ------------------------------ |
| Heartbeat interval             | 10 seconds                     |
| Stale after                    | 60 seconds without a heartbeat |
| Acquisition deadline           | 2 minutes                      |
| Retry interval while contended | 25 milliseconds                |

A holder that crashes stops heartbeating, and the next contender reclaims its
lock a minute later. A contender that cannot acquire within two minutes fails
rather than waiting forever.

## The fence is bounded, not absolute

Reclaiming a stale lock is a measurement followed by a separate removal, not
one atomic compare-and-swap. Once some holder has already gone stale, two
processes that both measure the same lock as stale both go on to reclaim it,
and the second reclaims whatever now sits at that path, including the fresh
lock the first just took. Releasing has the same shape: read the owner, then
remove the path.

Both windows open only after a holder has gone stale, and both leave the
fences that do not depend on this lock standing:

- `ArtifactSweep.RemoveOptions.ifUnmodifiedSinceMs`, which rides inside the
  deletion rather than in a prior read.
- The backup lease, which is a separate marker with its own gate.

So treat `required` as a strong guard against the ordinary
writer-versus-sweeper overlap, not as mutual exclusion that survives a crashed
holder plus a simultaneous reclaim. A holder whose host stalls past 60 seconds
can be reaped while it is still running.

## Both sides must agree

A lock fences only the parties that take it. Build a store and its sweep with
the same `directory` and the same `coordination`:

```ts
import * as ArtifactStore from "@smthrs/artifacts/ArtifactStore"
import * as ArtifactSweep from "@smthrs/artifacts/ArtifactSweep"
import * as Layer from "effect/Layer"

const directory = ".flows/objects"

export const artifacts = Layer.merge(
  ArtifactStore.layerFileSystem({ directory, coordination: "required" }),
  ArtifactSweep.layerFileSystem({ directory, coordination: "required" })
)
```

Nothing checks the pairing, and a mismatch is silent. A sweep on `required`
beside a store on `process` takes lock files no writer ever observes: the fence
reads as armed and protects nothing.

A store on `process` also gives up cross-process exclusion between writers and
sweep deletion, and a sweep on `process` skips the backup lease entirely.

## The backup lease

A filesystem backup freezes a database and then copies the blobs that database
references. Publication during that window is fine, because a new blob cannot
already be referenced by a frozen snapshot. Deletion is not: a sweep that
removes a blob the frozen database names leaves a backup that cannot be
restored.

`ArtifactBackupLease` is the exclusion for exactly that. The backup holds one
heartbeat-backed marker, `.backup-lease`, for the whole copy, with the same 10
second heartbeat and 60 second staleness bound as the digest locks. Sweep
deletion checks that marker while holding a short-lived workspace-global gate,
`.backup-lease-gate`, so the check and the delete cannot be separated. A
crashed lease becomes reclaimable once its heartbeat goes stale.

`ArtifactBackupLease.unlessActive` answers `None` when a live backup fenced the
operation, and `ArtifactSweep.remove` turns that into `false`. See
[Fence a backup against the sweep](../guides/fence-a-backup.md).

## What coordination costs

Under `required`, one sweep deletion takes two locks, the per-digest lock and
then the workspace-global backup-lease gate. That is roughly ten filesystem
operations and two forked heartbeat fibers per blob. The gate is one file for
the whole workspace, so concurrent deletions serialize through it.

That is the price of never deleting a blob a running backup already recorded.
Size a collection window with it in mind: a sweep of ten thousand blobs is
tens of thousands of filesystem operations, not ten thousand unlinks.

## Crash orphans

Lock files and temp payloads outlive a hard-killed process. Nothing else
observes either, because reads resolve only canonical paths and a lock is
reclaimed on contention alone, so a digest nobody publishes again would keep
its lock file forever.

Each filesystem store therefore runs one conservative sweep of its own scratch
on its first publication: `.tmp-*` payloads and `.locks/` entries whose
modification time is more than an hour old. An hour is far beyond any live
writer's publication window and sixty times the lock staleness bound, so a file
that old belongs to no living holder. A file whose age the host cannot report
says nothing about its owner and survives.

This is a sweep of scratch, not garbage collection. Reclaiming published
artifacts is always an explicit `ArtifactSweep` call.

## Related

- [Reclaim disk space](../guides/reclaim-disk-space.md): the sweep, its
  inventory, and the mtime fence.
- [Fence a backup against the sweep](../guides/fence-a-backup.md): holding the
  lease from a backup tool.
- [Troubleshooting](../troubleshooting.md): what a lock timeout looks like and
  what to change.
