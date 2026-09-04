---
title: "Fence a backup against the sweep"
description: "Hold ArtifactBackupLease.withLease around a filesystem backup so a concurrent sweep cannot delete a blob the frozen database references, and use unlessActive when you are the one deleting."
sidebar:
  order: 4
---

A filesystem backup freezes a database and then copies the blobs that database
references. Between the freeze and the last copy, a garbage collector running
in another process can delete a blob the frozen snapshot names, leaving a
backup that cannot be restored.

`ArtifactBackupLease` is the cross-process exclusion for exactly that window.

## Before you start

- The objects directory the store publishes into. The lease marker lives inside
  it, so a backup and a sweep pointed at different directories fence nothing.
- Both sides on `coordination: "required"`. A sweep built with `process` skips
  the lease entirely.

## Hold the lease around the copy

`withLease` acquires the marker, heartbeats it while your effect runs, and
releases it afterwards. Pass a `failure` function that maps an unknown host
cause into your own error type:

```ts
import * as ArtifactBackupLease from "@smthrs/artifacts/ArtifactBackupLease"
import * as ArtifactStore from "@smthrs/artifacts/ArtifactStore"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"

const leaseFailure = (cause: unknown): ArtifactStore.ArtifactStoreError =>
  new ArtifactStore.ArtifactStoreError({
    code: "unavailable",
    message: "the artifact backup lease could not be held",
    cause
  })

/** Runs `copy` while no sweep in any process can delete a referenced blob. */
export const underLease = <A, E, R>(copy: Effect.Effect<A, E, R>) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    return yield* ArtifactBackupLease.withLease(fs, ArtifactStore.defaultDirectory, copy, leaseFailure)
  })
```

Wrap the whole backup, from the database freeze through the last blob copy. A
lease held only around the copy leaves the freeze unprotected, which is where
the reference list came from.

## What the lease stops, and what it does not

It stops deletion. It does not stop publication: new blobs may appear
throughout a backup, and that is harmless, because a blob published after the
freeze cannot be referenced by the frozen database.

The bounds are the same ones the per-digest locks use:

| Bound                | Value                          |
| -------------------- | ------------------------------ |
| Heartbeat interval   | 10 seconds                     |
| Stale after          | 60 seconds without a heartbeat |
| Acquisition deadline | 2 minutes                      |

A crashed backup stops heartbeating, and its marker becomes reclaimable a
minute later, so a hard-killed process cannot fence collection forever. The
flip side is that a backup whose host stalls past 60 seconds can have its lease
reaped while it is still copying.

Releasing is tolerant of that. A lease whose heartbeat lapsed has its marker
reaped by whoever noticed, so finding nothing to release is the ordinary end of
a slow lease rather than a fault.

Acquisition is bounded rather than infinite: if another backup holds the lease
for more than two minutes, `withLease` fails through your `failure` function
instead of waiting.

## When you are the one deleting

`ArtifactSweep.remove` already consults the lease under
`coordination: "required"`, so a collector built on that surface needs nothing
here. Use `ArtifactBackupLease.unlessActive` only when you are writing a
different deletion path over the same objects directory:

`unlessActive` runs your effect only when no live lease exists, and it holds
the workspace-global gate across both the check and the effect, so the two
cannot be separated by a backup starting in between. It answers `Option.none()`
when a backup deliberately fenced the operation, which is what
`ArtifactSweep.remove` turns into `false`:

```ts
import * as ArtifactBackupLease from "@smthrs/artifacts/ArtifactBackupLease"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Option from "effect/Option"

/** Deletes one path unless a live backup fenced the deletion. */
export const removeUnlessBackingUp = (directory: string, path: string) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const outcome = yield* ArtifactBackupLease.unlessActive(
      fs,
      directory,
      fs.remove(path).pipe(Effect.as(true), Effect.mapError(leaseFailure)),
      leaseFailure
    )
    return Option.getOrElse(outcome, () => false)
  })
```

Treat `none` as "nothing was reclaimed, retry after the backup finishes", never
as "the blob is gone".

## Related

- [Reclaim disk space](./reclaim-disk-space.md): the collector side, and why
  its `false` is ambiguous on purpose.
- [Coordination between processes](../concepts/coordination.md): the gate, the
  markers, and the stale-reclaim window they share.
- [Retention and cleanup](/docs/guides/retention/): backing up a project before
  collecting it, on smithers.sh.
