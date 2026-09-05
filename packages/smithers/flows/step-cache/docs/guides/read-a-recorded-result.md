---
title: "Read the result one event recorded"
description: "Use the recordedBy provenance fence so a replay reads the bytes its own journal event landed, whatever has happened to the mutable head since."
sidebar:
  order: 2
---

An ordinary lookup answers the mutable head: whatever result is currently
recorded under the digest. A replay cannot use that answer. It is re-deriving a
projection of one past frame, and that projection has to stay a function of
durable state, so it must read the bytes its own event recorded even after the
head has moved.

Name the event, and the store reads the ledger:

```ts
import * as CacheStore from "@smthrs/step-cache/CacheStore"
import * as Effect from "effect/Effect"

const replayRead = Effect.gen(function*() {
  const cache = yield* CacheStore.CacheStore
  return yield* cache.get("compile-server-v1", {
    recordedBy: { runId: "run-a", eventSeq: 7 }
  })
})
```

## What the fence does

The store reads `flows_step_cache_recorded` for that exact
`(keyDigest, runId, eventSeq)` triple. If it holds a row, that row is the
answer. If it holds none, the lookup falls back to the mutable head.

Both halves of the pair are load bearing. Sequence numbers are per run and
collide across runs routinely, so `eventSeq` alone names many events.

## When the fallback is right, and when it is not

The head fallback exists for entries recorded under some other provenance: a
fork sharing its parent's keys, or a write-back from a shared tier. In those
cases the ledger holds nothing for the caller's event and the head is the only
durable answer there is.

The fallback does not fire when the ledger holds the row and something else
refuses it. A lookup that names a provenance the ledger holds and an
[age bound](./expire-cached-results.md) that refuses it answers a miss:

```ts
const bounded = Effect.gen(function*() {
  const cache = yield* CacheStore.CacheStore
  return yield* cache.get("compile-server-v1", {
    recordedBy: { runId: "run-a", eventSeq: 7 },
    maxAgeMs: 10_000
  })
})
```

Falling through to the head there would hand the replay whatever a later run
recorded under the same digest, which is a different result than the one the
caller asked to read.

## Validate before you reach the store

A malformed selector fails with `invalid_cache` before any statement is issued,
naming the provenance contract, rather than reading as an ordinary miss. An
empty `runId`, a fractional `eventSeq`, or a negative one is a caller mistake,
and the store reports it as one. The same check is exported as
`CacheStore.validateRecordedBy` if you need it in an adapter.

## Against a shared tier

`RemoteCacheStore` carries the fence as the `recordedRunId` and
`recordedEventSeq` query parameters, and a conforming tier answers the recorded
entry when it still holds one and its head otherwise, which is the SQL tier's
rule exactly.

:::caution
A tier that ignores query parameters degrades silently: the fenced lookup
becomes a head read, and the client cannot tell the difference, because an
entry recorded under different provenance is the documented fallback. Fenced
reads need a conforming server. See
[implement a shared cache server](./implement-a-shared-tier.md).
:::

## Where to go next

- [The head and the ledger](../concepts/head-and-ledger.md): why the ledger row
  is immutable.
- [Evict a poisoned entry](./evict-a-poisoned-entry.md): the same provenance
  pair, used as a delete predicate.
