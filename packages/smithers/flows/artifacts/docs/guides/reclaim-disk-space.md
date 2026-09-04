---
title: "Reclaim disk space"
description: "Enumerate an objects directory with ArtifactSweep, delete a blob behind the mtime fence, count only what you actually reclaimed, and hand the policy to the engine collector that owns it."
sidebar:
  order: 3
---

An objects directory grows forever unless something removes from it. This
package ships the mechanics: enumerate what is there, and delete one blob
safely. It ships no policy, because deciding which digests are still live needs
the durable roots, and only the engine composition can see those.

Most projects never call this API directly.
[`@smthrs/engine-store`](/api/engine-store)'s `ArtifactGc` is the collector
built on it: its mark phase walks the durable roots, and `gc()` is an explicit
call that nothing schedules, because deletion is the irreversible direction.
Note that [`smthrs gc`](/cli/gc) collects terminal runs and does not touch the
artifact tier at all.
[Retention and cleanup](/docs/guides/retention/#4-sweep-unreferenced-artifacts)
is the operator's version of this page. Read on if you are writing a collector
of your own.

## Before you start

- The objects directory the store publishes into. Get it wrong and you
  enumerate somewhere nothing was ever written.
- A live set: the digests something still references. Producing one is your
  collector's job, not this package's.

## 1. Provide the sweep beside the store

Build both with the same `directory` and the same `coordination`. Nothing
checks the pairing, and a mismatch is silent:

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

`SweepOptions` has no `durability` field, deliberately: a sweep never writes a
blob, so accepting the option and ignoring it would be a lie.

## 2. Enumerate what is on disk

`inventory` returns a `BlobStat` for each canonical blob: its digest, its
modification time in milliseconds, and its size in bytes.

It is conservative by construction. Only paths in the store's canonical fanout
shape are blobs, so temp files, lock files, foreign files, nested paths, and a
directory sitting at a blob address are all skipped rather than deleted. A blob
that vanishes between the listing and the stat was removed by someone else and
is skipped too. So is one whose modification time the host cannot report: what
the sweep cannot judge, it must not touch.

A store that never published anything has no directory at all. That is an empty
inventory, not a failure.

## 3. Delete behind the fence

`RemoveOptions.ifUnmodifiedSinceMs` rides inside the deletion rather than in a
prior read. A blob freshened after you computed your live set, by a concurrent
put re-referencing the same bytes, fails the fence and survives:

```ts
import * as ArtifactSweep from "@smthrs/artifacts/ArtifactSweep"
import * as Effect from "effect/Effect"

/** Removes every blob outside `live` that has not been touched since `keepAfterMs`. */
export const collect = (live: ReadonlySet<string>, keepAfterMs: number) =>
  Effect.gen(function*() {
    const sweep = yield* ArtifactSweep.ArtifactSweep
    let reclaimedBytes = 0
    for (const blob of yield* sweep.inventory) {
      if (live.has(blob.digest) || blob.modifiedAtMs > keepAfterMs) continue
      const removed = yield* sweep.remove(blob.digest, { ifUnmodifiedSinceMs: keepAfterMs })
      if (removed) reclaimedBytes += blob.sizeBytes
    }
    return reclaimedBytes
  })
```

The inventory check is the cheap filter; the fence in `remove` is the one that
actually holds, because the world can change between the two.

`keepAfterMs` is where a grace period lives. Pick an instant far enough in the
past that a blob published or freshened while your mark phase was running
survives this pass: `ArtifactGc` defaults to two weeks.

## 4. Read the boolean correctly

`remove` reports whether bytes were removed. A missing blob reports `false`
rather than failing, so a crashed and re-run sweep converges instead of erroring
on its own progress.

`false` covers three outcomes a caller cannot tell apart:

- The blob was already gone.
- It failed the `ifUnmodifiedSinceMs` fence.
- A live backup lease fenced the deletion.

All three mean nothing was reclaimed and retrying later is safe. The third is
not progress: the blob is still there, so a collector counting reclaimed bytes
must not count it, and the next pass after the backup finishes removes it. The
loop above already gets this right by adding `blob.sizeBytes` only on `true`.

## 5. Budget for the coordination cost

Under `coordination: "required"`, one deletion takes the per-digest lock and
then the workspace-global backup-lease gate: roughly ten filesystem operations
and two forked heartbeat fibers per blob. The gate is one file for the whole
workspace, so concurrent deletions serialize through it.

That is the price of never deleting a blob a running backup already recorded.
Size a collection window with it in mind rather than assuming one unlink per
blob.

## Verify it worked

Count the blobs before and after:

```bash
find .flows/objects -type f -name '????????????????????????????????????????????????????????????????' | wc -l
```

The name pattern matches a 64-character digest, so temp and lock files stay out
of the count.

## Related

- [Fence a backup against the sweep](./fence-a-backup.md): the other side of
  the lease this sweep consults.
- [Coordination between processes](../concepts/coordination.md): the lock
  protocol, its bounds, and what still holds when the lock does not.
- [Retention and cleanup](/docs/guides/retention/): the operator's runbook on
  smithers.sh.
