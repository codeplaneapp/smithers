# @smthrs/step-cache

The Smithers step result cache: which sealed action results may be reused.
Split out of `@smthrs/journal`; see
[journal concepts](../../docs/pages/concepts/journal.md).

`CacheStore` is a keyed memoization of sealed step results, addressed by the
step key digest of [step keys](../../docs/pages/concepts/step-keys.md). It is
deliberately called a _cache_: entries may be evicted, a stale entry is a miss
rather than a corruption, and admission is gated the same way for normal
execution, replay, and speculation validation alike.

It shares nothing with the journal or the run store beyond the database
underneath, which is why it is its own package and depends only on
`@smthrs/database`.

```sh
pnpm add @smthrs/step-cache
```

## Public API

The root exports these namespaces, also available from matching
`@smthrs/step-cache/*` subpaths.

| Namespace    | Public exports                                                                                                                                                                                            |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CacheStore` | `CacheStoreErrorCode`, `CacheStoreError`, `CacheEntry`, and `PutResult`; `Service` / `CacheStore` operations `get`, `put`, `evict`, and `sweepExpired`; `make`, `makeNoop`, `layerNoop`, and SQL `layer`. |
| `Migrations` | `set` (the namespaced migration set for `flows_step_cache`), `run`, and prerequisite `layer`.                                                                                                             |

The root is written against the driver-neutral `@smthrs/database` contract and
bundles for the browser. The test double binds a Node SQLite database, so it
lives under an explicit subpath:

| Import                                   | Public exports                                                |
| ---------------------------------------- | ------------------------------------------------------------- |
| `@smthrs/step-cache/test/TestCacheStore` | **Node only.** `layer`, providing a migrated in-memory cache. |

An engine needs this package, `@smthrs/journal`, and `@smthrs/run-store` over
one database; `@smthrs/engine-store/Migrations` composes all four migration
sets, and `@smthrs/engine-store/test/TestStores` is the in-memory bundle.

```ts
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import { CacheStore, Migrations } from "@smthrs/step-cache"
import { Effect, Layer } from "effect"

const database = NodeDatabase.layer({ filename: "flows.db" })
const cache = CacheStore.layer.pipe(
  Layer.provide(Layer.provideMerge(Migrations.layer, database))
)

const program = Effect.gen(function*() {
  const store = yield* CacheStore.CacheStore
  return yield* store.get("digest")
}).pipe(Effect.provide(cache))
```

## Age bounds

`get(keyDigest, { maxAgeMs })` refuses a row recorded more than `maxAgeMs`
before the current clock reading, so a caller that declared a time to live
reads a miss instead of a stale result. The bound is a read policy: the row
stays on disk, and a second caller declaring a longer bound still reads it.

A lookup that also names `recordedBy` reads that exact ledger row. When the
bound refuses it the answer is a miss, not the head row: the head may hold a
result a later run recorded, and a replay of the named event must read that
event's row or nothing.

`sweepExpired(olderThanMs)` is the collection half. It deletes head rows older
than the bound and answers how many it deleted. It never touches the
append-only `flows_step_cache_recorded` ledger, because an old frame's replay
projects what that event recorded and deleting the evidence would change a
replayed answer.

See the [step-cache reference](../../docs/pages/api/step-cache.md) and
[step keys](../../docs/pages/concepts/step-keys.md).
