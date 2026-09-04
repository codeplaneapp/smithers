---
title: "@smthrs/step-cache"
description: "The Smithers step result cache: durable content-addressed storage for sealed step results, an append-only provenance ledger a replay reads through, and an optional shared HTTP tier."
---

`@smthrs/step-cache` answers one question: may this sealed result be reused?

A durable run seals a step, digests everything the step depends on, and records
the result under that digest. The next execution that derives the same digest
reads the recorded result instead of doing the work again. This package is the
store behind that read, and behind the write that fills it.

It is deliberately a _cache_. Entries may be evicted, a stale entry is a miss
rather than a corruption, and one admission gate serves normal execution,
replay, and speculation validation alike. What is not a cache is the provenance
ledger beside it: every recording also lands an immutable row keyed by the exact
journal event that made it, and no verb in this package deletes one. Evicting
the reusable copy protects future executions from a poisoned result; it never
rewrites what a past run recorded.

## Who uses this package

Engine authors compose it: [`@smthrs/engine-store`](/api/engine-store) reads it
when a sealed action dispatches and writes it when one settles. A host that
wants two machines to share step results composes the HTTP tier under it.
Nothing above the engine calls this store directly, so a workflow author meets
it as the reason a step did not run twice.

## Install

```bash
pnpm add @smthrs/step-cache
```

For the driver and write boundary a real composition adds, see
[Installation](./installation.md).

## The smallest real use

```ts
import * as CacheStore from "@smthrs/step-cache/CacheStore"
import * as TestCacheStore from "@smthrs/step-cache/test/TestCacheStore"
import * as Effect from "effect/Effect"

const program = Effect.gen(function*() {
  const cache = yield* CacheStore.CacheStore
  yield* cache.put({
    keyDigest: "b1946ac92492d2347c6235b4d2611184",
    result: { artifact: "dist/server.js" },
    meta: { durationMs: 1_820 },
    createdAtMs: Date.now(),
    recordedRunId: "run-1",
    recordedEventSeq: 7
  })
  return yield* cache.get("b1946ac92492d2347c6235b4d2611184")
})

Effect.runPromise(Effect.provide(program, TestCacheStore.layer).pipe(Effect.orDie))
```

`put` answers `Inserted`, `ExistingSame`, or `Conflict`, and `get` answers an
`Option`. For the whole cycle, including the provenance fence and eviction, see
the [Quickstart](./quickstart.md).

## The package at a glance

The root entry point exports these namespaces, and each is also importable from
`@smthrs/step-cache/<Module>`:

| Namespace            | What it is                                                                                                                   |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `CacheStore`         | The service contract and its SQL implementation, plus the schemas, limits, validators, and error vocabulary of the boundary. |
| `CacheStoreMetrics`  | The hit, miss, and recording-outcome counters the SQL store updates.                                                         |
| `CombinedCacheStore` | Local-first read-through, local write-back, and inline or deferred publication to a shared tier.                             |
| `RemoteCacheStore`   | The shared tier as an HTTP client: a bounded action cache under `/ac/{keyDigest}`.                                           |
| `Migrations`         | The namespaced migration set for the two tables, and the layer that installs them.                                           |

The Node-only test layer is at `@smthrs/step-cache/test/TestCacheStore`. Every
export, with signatures, is on the [API reference](./api.md).

## Where to go next

- [Installation](./installation.md): requirements, import forms, and the
  packages a runnable composition adds.
- [Quickstart](./quickstart.md): record a result, read it back through its
  provenance, expire it, and evict it.
- Concepts: [the head and the ledger](./concepts/head-and-ledger.md),
  [what the cache admits](./concepts/admission.md), and
  [local and shared tiers](./concepts/tiers.md).
- Guides: [compose a durable step cache](./guides/compose-a-store.md),
  [read the result one event recorded](./guides/read-a-recorded-result.md),
  [expire cached results](./guides/expire-cached-results.md),
  [evict a poisoned entry](./guides/evict-a-poisoned-entry.md),
  [share results across machines](./guides/share-results-across-machines.md),
  [implement a shared cache server](./guides/implement-a-shared-tier.md),
  [observe cache outcomes](./guides/observe-cache-outcomes.md), and
  [test against the step cache](./guides/test-with-the-cache.md).
- [Troubleshooting](./troubleshooting.md): every failure this package reports,
  what causes it, and what to change.
