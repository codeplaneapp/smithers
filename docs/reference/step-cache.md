# `@smthrs/step-cache`

This page is the public API reference for the **step result cache**: sealed
action results addressed by step-key digest. It was split out of
`@smthrs/journal` — see
[`docs/specs/Concepts/Journal Split.md`](../../../docs/specs/Concepts/Journal%20Split.md).

It is deliberately a *cache*. Entries may be evicted, a stale entry is a miss
rather than a corruption, and the same admission gate serves normal execution,
replay, and speculation validation alike. The package depends on
`@smthrs/database` and nothing else.

## CacheStore

`CacheStore` exposes `get`, `put`, and `evict`. `put` returns `Inserted`, `ExistingSame`, or `Conflict`; cache entries retain the recording run and journal sequence as provenance. `evict(keyDigest, { ifRecordedBy })` deletes only while the row still carries that `(runId, eventSeq)` pair — both halves, since sequence numbers are per-run and collide across runs routinely. Whether the insert conflicted and whether the fenced delete hit are read through [`DurableWriter.affectedRows`](database.md#durablewriter) rather than a driver-specific `changes` cast, so the outcomes hold on every backend (issue #134).

`CacheStore` exports SQL `make`/`layer` plus a no-op test seam.

A cache hit *is* the step's result, so cached rows are never redacted: a
name-suffix redactor there would hand the flow a `"[REDACTED]"` string where it
expected its own value (issue #72). `CacheStore.layer` round-trips `result` and
`meta` byte-for-byte.

## RemoteCacheStore and CombinedCacheStore

`RemoteCacheStore` is the same contract spoken over HTTP — `GET`/`PUT`/`DELETE
/ac/{keyDigest}` carrying the `CacheEntry` JSON — mirroring the action-cache
half of Bazel's dumb-HTTP remote cache. `201 Created` is `Inserted`, any other
2xx is `ExistingSame`, `409` is `Conflict`, which is the smallest vocabulary
that preserves first-writer-wins over plain HTTP. A lookup that comes back
recorded under a *different* key is refused: a tier answering with someone
else's entry would hand the caller a result under the wrong key. The endpoint
and its headers are layer construction options — a capability, never an input,
and never part of a step key.

`CombinedCacheStore` composes a local and a remote tier: local first, remote
second, writing the shared entry back into the local SQL store so the next
lookup is local. A local `Conflict` is never published upward. Eviction is
deliberately local-only — every engine eviction is a "this host observed this
row to be poison" judgement, and none of those observations generalize to a
tier where another machine may still hold the artifacts this one lost.

**Publication order is the caller's job.** A cache entry must never be
observable in the shared tier while an artifact it references is missing from
the shared artifact tier; `@smthrs/engine-store`'s `ArtifactSync` enforces that
around `put`. *When* the shared copy is written is the caller's too:
`publication: "deferred"` makes `put` write the local tier only, so a caller
holding a write transaction can publish afterwards rather than hold a network
round trip across it. That is the mode the engine composes, publishing through
its own `CacheSync` seam. See [`@smthrs/artifacts`](artifacts.md) and
[Remote cache](../../../docs/specs/Concepts/Remote%20Cache.md).

## Entry points

The root is written against the driver-neutral `@smthrs/database` service and
bundles for the browser (`pnpm run browser`). The test double binds a Node
SQLite database and is therefore imported from
`@smthrs/step-cache/test/TestCacheStore`. See
[browser support](../architecture/browser-support.md).

## Migrations

`Migrations.set` is this package's namespaced migration set —
`flows_step_cache` — and reserves migration id block `2000`. `Migrations.run` /
`Migrations.layer` install it alone; `@smthrs/engine-store/Migrations` composes
it with the journal's, the run store's, and the engine's. See
[`@smthrs/database`](database.md) for the composition rules.

See [Step keys](../../../docs/specs/Concepts/Step%20Keys.md) and the
[`@smthrs/engine-store` reference](engine-store.md).
