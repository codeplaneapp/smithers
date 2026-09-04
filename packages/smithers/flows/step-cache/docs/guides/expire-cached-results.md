---
title: "Expire cached results"
description: "Bound what a lookup will serve with maxAgeMs, reclaim the rows nothing will read again with sweepExpired, and keep a declared TTL where it belongs."
sidebar:
  order: 3
---

A cached step result is a claim about work that was correct when it was
recorded. A caller who believes the claim decays needs two different things:
a read that refuses an old row, and a job that removes the rows nothing will
read again. They are separate on purpose.

## Refuse an old row on read

`maxAgeMs` measures the entry's `createdAtMs` against the current clock reading
and answers a miss when the row is older than the bound:

```ts
import * as CacheStore from "@smthrs/step-cache/CacheStore"
import * as Effect from "effect/Effect"

const withinTheHour = Effect.gen(function*() {
  const cache = yield* CacheStore.CacheStore
  return yield* cache.get("compile-server-v1", { maxAgeMs: 3_600_000 })
})
```

Three properties of the bound matter:

- It bounds the recorded ledger and the head alike. Both rows carry the
  `createdAtMs` the age is measured from.
- One lookup resolves its age floor once, from the injected clock, so a row
  cannot be fresh for the ledger read and stale for the head read of the same
  call. Tests drive it with `TestClock`.
- It is a read policy, never a deletion. The row stays on disk, so a second
  caller declaring a longer bound still reads it.

A bound that is not a non-negative safe integer fails with `invalid_cache`
rather than reading as a miss.

## Reclaim what nothing will read

`sweepExpired` is the collection half. It deletes head rows recorded strictly
before the floor and answers how many it deleted:

```ts
const nightly = Effect.gen(function*() {
  const cache = yield* CacheStore.CacheStore
  return yield* cache.sweepExpired(7 * 24 * 60 * 60 * 1_000)
})
```

A row recorded exactly at the floor survives, which makes the boundary the same
one `maxAgeMs` uses. Only `flows_step_cache` is swept. The append-only ledger
is never touched: an old frame's projection is a function of what its event
recorded, and deleting the evidence would change a replayed answer. What does
reclaim ledger rows, and what never does, is in
[the head and the ledger](../concepts/head-and-ledger.md).

In a two-tier composition the sweep is local only. The shared tier owns its own
retention, and `RemoteCacheStore.sweepExpired` answers `0` without issuing a
request.

## Keep a declared TTL out of the store

A caller-facing `CachePolicy` annotation, `{ ttlMs?, scope? }`, is declared by
[`@smthrs/flow`](/api/flow) and [`@smthrs/patterns`](/api/patterns), and read at
dispatch by [`@smthrs/engine-store`](/api/engine-store), which owns what it
means and journals the decision it takes. Those packages are the contract for
it.

The boundary between that and this store is worth stating: `maxAgeMs`
re-derives its answer from a fresh clock reading on every lookup, which is
exactly why the dispatch path does not use it for a declared `ttlMs`. A replay
must reach the verdict the first execution reached, so that decision is
journaled rather than recomputed here.

## Where to go next

- [Evict a poisoned entry](./evict-a-poisoned-entry.md): removing one named
  row rather than a whole age band.
- [Read the result one event recorded](./read-a-recorded-result.md): how a
  bound interacts with a provenance fence.
