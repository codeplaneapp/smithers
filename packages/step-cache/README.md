# @smthrs/step-cache

Durable, content-addressed storage for sealed step results. Entries are
reusable execution evidence, but the mutable head remains a cache: it may be
expired or evicted without rewriting the append-only provenance ledger.

```sh
pnpm add @smthrs/step-cache
```

The package depends on `@smthrs/canonical` for stable JSON and
`@smthrs/database` for driver-neutral durable writes. Its root remains
browser-bundleable; only the explicit test helper binds Node SQLite.

## Public API

The root exports five namespaces, also available through matching subpaths.

| Namespace            | Contract                                                                                                                                                                     |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CacheStore`         | Schemas, limits, validation helpers, `CacheStoreError`, `get`, `put`, fenced `evict`, `sweepExpired`, SQL `layer`, and explicit failing `makeNoop` / `layerNoop` test seams. |
| `CacheStoreMetrics`  | Hit, miss, and put-outcome counters.                                                                                                                                         |
| `CombinedCacheStore` | Local-first read-through, local write-back, and inline or deferred remote publication.                                                                                       |
| `RemoteCacheStore`   | Bounded HTTP action-cache client under `/ac/{keyDigest}`.                                                                                                                    |
| `Migrations`         | Namespaced migration `set`, `run`, and prerequisite `layer`.                                                                                                                 |

`CacheStore` also exposes `encodeCanonical`, `validateKey`,
`validateRecordedBy`, `validateFence`, `validateAge`, and `snapshotEntry` for
adapters implementing the same boundary. Internal migration implementation
files are not exported.

The Node-only test layer is available at
`@smthrs/step-cache/test/TestCacheStore`.

## Durable contract

- A key is one URL-segment-safe digest matching `[A-Za-z0-9_-]{1,256}`.
- `put` is first-writer-wins. It returns `Inserted`, `ExistingSame`, or
  `Conflict`; an exact `(keyDigest, recordedRunId, recordedEventSeq)` provenance
  record is immutable even after the mutable head is evicted.
- Inputs are detached and frozen at effect start. Accessors, sparse or cyclic
  structures, non-JSON values, ill-formed Unicode, and hostile object shells
  are rejected without executing user hooks.
- Each `result` and `meta` tree is bounded to 4 MiB, depth 128, 100,000 nodes,
  and 100,000 members. Run ids are non-empty, control-free, well-formed text of
  at most 1,024 UTF-16 code units. Timestamps and event sequences are
  non-negative safe integers.
- `CacheStoreError.code` is one of `invalid_cache`, `constraint`,
  `decode_failed`, `persistence_failed`, or `unknown`. Boundary diagnostics do
  not retain rejected payloads or transport causes.

`get(keyDigest, { recordedBy, maxAgeMs })` can select the immutable provenance
row for one journal event and apply a read-only age bound. An expired recorded
row is a miss, never a fallback to a newer head. `evict(keyDigest, {
ifRecordedBy })` performs one compare-and-swap delete. `sweepExpired` removes
old heads only; it never deletes provenance.

## Local and remote composition

```ts
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import { CacheStore, CombinedCacheStore, Migrations, RemoteCacheStore } from "@smthrs/step-cache"
import { Effect, Layer } from "effect"

const database = NodeDatabase.layer({ filename: "flows.db" })
const local = CacheStore.layer.pipe(
  Layer.provide(Layer.provideMerge(Migrations.layer, database))
)

const remote = RemoteCacheStore.make({
  endpoint: "https://cache.example.com/base",
  headers: { authorization: "Bearer …" },
  requestTimeout: "30 seconds"
})

const cache = CombinedCacheStore.layer({
  local: Effect.service(CacheStore.CacheStore).pipe(Effect.provide(local)),
  remote,
  publication: "deferred"
})
```

Remote endpoints must use HTTPS, except loopback HTTP for local development.
Credentials in `headers` are snapshotted once at construction. Every request
and response body is finite: the default deadline is 60 seconds and the
response limit is 4 MiB. A lookup maps `404` to a miss; publication maps `201`
to `Inserted`, other successful statuses to `ExistingSame`, and `409` to
`Conflict`. Remote retention is server-owned, so `sweepExpired` validates its
argument and returns zero.

When entries reference artifacts, publish every artifact to the shared
artifact tier before publishing the cache entry. Use deferred publication when
the local write occurs inside a database transaction; perform remote I/O only
after that transaction commits.

See the [step-cache API](https://smithers.sh/api/step-cache),
[step-key contract](https://smithers.sh/concepts/step-keys), and
[journal architecture](https://smithers.sh/concepts/journal).
