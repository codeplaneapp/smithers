---
description: "Sealed step results addressed by step-key digest, in a local SQL tier and a remote one."
---

# @smthrs/step-cache

Sealed step results addressed by step-key digest. Split out of [`@smthrs/journal`](/api/journal); it depends on `@smthrs/database` and nothing else, so the package root bundles for the browser.

```ts
import { CacheStore, Migrations } from "@smthrs/step-cache"
import * as Layer from "effect/Layer"

const layer = CacheStore.layer.pipe(Layer.provideMerge(Migrations.layer))
```

## Entry points

| Import | Source | Platform |
| --- | --- | --- |
| `@smthrs/step-cache` | [src/index.ts](https://github.com/smithersai/smithers/blob/main/packages/step-cache/src/index.ts) | any |
| `@smthrs/step-cache/test/TestCacheStore` | [src/test/TestCacheStore.ts](https://github.com/smithersai/smithers/blob/main/packages/step-cache/src/test/TestCacheStore.ts) | Node |

## CacheStore

[src/CacheStore.ts](https://github.com/smithersai/smithers/blob/main/packages/step-cache/src/CacheStore.ts)

| Export | Kind | Notes |
| --- | --- | --- |
| `CacheStore` | service tag | digest to result, first writer wins |
| `CacheEntry` | interface | `resultJson`, `metaJson`, `createdAtMs`, `recordedRunId`, `recordedEventSeq` |
| `PutResult` | type | `Inserted`, `ExistingSame`, `Conflict` |
| `EvictOptions` | type | eviction arguments |
| `CacheStoreError`, `CacheStoreErrorCode` | class + codes | |
| `make`, `makeNoop` | constructors | |
| `layer`, `layerNoop` | layers | |

## CacheStoreMetrics

[src/CacheStoreMetrics.ts](https://github.com/smithersai/smithers/blob/main/packages/step-cache/src/CacheStoreMetrics.ts)

| Export | Kind | Notes |
| --- | --- | --- |
| `lookups` | counter | `flows_step_cache_lookups`, dimensioned by `outcome` |
| `hit`, `miss` | attributed views | `CacheStore.get` updates one per lookup |
| `puts` | counter | `flows_step_cache_puts`, dimensioned by `outcome` |
| `put` | attributed views | keyed by the `PutResult` tag; `conflict` is the signal `Inconsistency` receivers act on |

## RemoteCacheStore

[src/RemoteCacheStore.ts](https://github.com/smithersai/smithers/blob/main/packages/step-cache/src/RemoteCacheStore.ts)

| Export | Kind | Notes |
| --- | --- | --- |
| `Options` | interface | `endpoint`, `headers`; a capability, never a step-key input |
| `make`, `layer` | constructor + layer | `GET`/`PUT`/`DELETE /ac/{keyDigest}` over Effect's `HttpClient` |

## CombinedCacheStore

[src/CombinedCacheStore.ts](https://github.com/smithersai/smithers/blob/main/packages/step-cache/src/CombinedCacheStore.ts)

| Export | Kind | Notes |
| --- | --- | --- |
| `Options` | interface | the `local` and `remote` tiers, plus `publication: "inline" \| "deferred"` |
| `make`, `layer` | constructor + layer | local-first lookup with write-back into the local SQL store; eviction stays local |

`publication` defaults to `"inline"`, which writes both tiers in `put`. `"deferred"` writes the local tier only and leaves the shared write to the caller. `@smthrs/engine-store` composes this mode and publishes through its `CacheSync` seam once the transaction commits.

:::danger
A write transaction must never span a host call. A caller holding one wants `"deferred"`.
:::

## Migrations

[src/Migrations.ts](https://github.com/smithersai/smithers/blob/main/packages/step-cache/src/Migrations.ts)

| Export | Kind | Notes |
| --- | --- | --- |
| `set` | `MigrationSet` | the namespaced set for `flows_step_cache`, in id block `2000` |
| `run` | effect | apply the cache schema |
| `layer` | layer | applies it at construction |

## Test layers

| Export | Source | Notes |
| --- | --- | --- |
| `TestCacheStore.layer` | [src/test/TestCacheStore.ts](https://github.com/smithersai/smithers/blob/main/packages/step-cache/src/test/TestCacheStore.ts) | a migrated step cache over in-memory SQLite |

## API reference

This page is the public API reference for the **step result cache**: sealed
action results addressed by step-key digest. It was split out of
`@smthrs/journal`: see
`docs/specs/Concepts/Journal Split.md`.

It is deliberately a *cache*. Entries may be evicted, a stale entry is a miss
rather than a corruption, and the same admission gate serves normal execution,
replay, and speculation validation alike. The package depends on
`@smthrs/database` and nothing else.

### CacheStore

`CacheStore` exposes `get`, `put`, and `evict`. `put` returns `Inserted`, `ExistingSame`, or `Conflict`; cache entries retain the recording run and journal sequence as provenance. `evict(keyDigest, { ifRecordedBy })` deletes only while the row still carries that `(runId, eventSeq)` pair: both halves, since sequence numbers are per-run and collide across runs routinely. Whether the insert conflicted and whether the fenced delete hit are read through [`DurableWriter.affectedRows`](/api/database#durablewriter) rather than a driver-specific `changes` cast, so the outcomes hold on every backend (issue #134).

`get` takes an optional age bound. `get(keyDigest, { maxAgeMs })` refuses a row
whose `createdAtMs` is more than `maxAgeMs` before the current clock reading and
counts the lookup as a miss, which is how a caller-declared time to live reaches
the store. The bound applies to the recorded ledger and to the head alike, and
one lookup resolves the floor once so a row cannot be fresh for one read and
stale for the other. It is a read policy, never a deletion: the row stays on
disk, so a second caller declaring a longer bound still reads it.

`recordedBy` and the bound compose in one direction only. A lookup that names a
provenance the ledger holds and the bound refuses answers a miss; it never falls
through to the head, because the head may carry a result a later run recorded
and a replay of that event must read that event's row or nothing. The head
fallback stays for the case it was built for: a provenance the ledger holds no
row for at all.

`sweepExpired(olderThanMs)` is the collection half, deleting head rows recorded
before the floor and answering how many it deleted. It never touches the
append-only `flows_step_cache_recorded` ledger: an old frame's replay projects
what that event recorded, so deleting the evidence would change a replayed
answer. `CombinedCacheStore` sweeps the local tier only, for the same reason it
evicts locally only, and `RemoteCacheStore.sweepExpired` validates its argument
and answers `0`: the shared tier owns its own retention.

`CacheStore` exports SQL `make`/`layer` plus a no-op test seam.

### Declared cache policy

`@smthrs/flow/CacheEnvironment` carries the caller-facing half as a
`CachePolicy` annotation, `{ ttlMs?, scope?: "run" | "flow" | "shared" }`, that
`@smthrs/engine-store` reads at dispatch. Declare it on an action with
`CacheEnvironment.withCache(action, policy)`, which is
`action.annotate(CacheEnvironment.CachePolicyAnnotation, policy)` under a name.
`@smthrs/patterns`'s `WithCache.withCache(inner, { ttlMs, scope, version })`
declares the same policy over a `@smthrs/core` flow, under one identifier,
`@smthrs/flow/Action/CachePolicy`, declared in both packages because neither
depends on the other; `packages/patterns/test/WithCache.test.ts` reads a
wrapper's annotations back with `@smthrs/flow`'s reader and fails if the
identifiers ever drift.

**What the engine honors today is the action form.** The durable engine executes
`@smthrs/flow` actions compiled from the `@smthrs/plan` AST, and flows HEAD has
no bridge from a `@smthrs/core` `Flow.make` descriptor to that interpreter, so a
`WithCache` wrapper over a core flow is a declaration: it renames the wrapper,
enters its captured key material, and carries the annotation the engine will
read once the bridge lowers it onto the dispatched action. The agent cell
runtime, which does execute core flows, keys sealed calls through
`WorkspaceSandbox` from the call's own material
(`packages/agent/src/FlowEngineLike.ts`) and reads no annotations at all. Declare
the policy on the action for a policy the engine acts on now.

`ttlMs` is decided once, durably. Before it serves or refuses a row, the engine
journals a `flows.engine.cache-provenance` record with `action: "ttl"`, the
bound, and `verdict: "admitted" | "expired"`, under a producer identity naming
the run, the step key, the decision, and the row's own recorded provenance. It
does not name the process: the identity is deliberately free of the host's
configured `journalSource`, because a run outlives the incarnation driving it
and a verdict keyed to the incarnation would be re-taken by the next one. On a
replay the same emit answers `Duplicate` when the verdict agrees and fails
`idempotency_conflict` when it does not, and the conflict names the recorded
verdict exactly, because `verdict` is the only field of that payload the
identity does not already fix. A dispatch that served a row at 900 ms and lost
its process therefore serves the same row at 1100 ms: from the same engine or
from the one that resumed the run: instead of expiring a result the run
already consumed. An
expired verdict is followed by a second record with `action: "expired"` carrying
the row's age, and by an eviction fenced on the row's own provenance, which
keeps the re-execution's newer result from colliding with the row it replaced.

`maxAgeMs` on `CacheStore.get` stays the store-level bound for a caller that
wants a read policy rather than a journalled decision. The dispatch path does not
use it, because a read policy re-derives its answer from a fresh clock on every
lookup and a replay must not.

`scope` narrows the cache row's address, not a read filter and not the step key.
`shared` is the unnarrowed default and folds nothing, so every digest predating
the policy keeps its bytes; `run` folds the run id and `flow` folds the executing
flow's tag into the material the row's address is taken over, so a sibling
derives a different address and never finds the row. A dispatch that reaches the
seam without an executing instance cannot name a flow, so `flow` narrows to the
run there: never wider than the caller asked for.

The step key digest itself is never narrowed. It addresses the dispatch's
`flows_attempts` rows, and the seams that read those rows back have only the key
to derive it from: `EngineStore.actionRetryOrigin` (the schedule-to-close
origin), `EngineStore.actionLatestAttempt` (the attempt counter), and
`PlanScheduler`, which maps an attempt's `stepKeyDigest` to the node that
dispatched it. Narrowing it would hide a scoped step's attempts from its own
retry counter and its deviations from the reconciler.

`@smthrs/patterns` `WithCache` declares the same three fields plus a `version`,
folding them into the wrapper's name and captured key material.

A cache hit *is* the step's result, so cached rows are never redacted: a
name-suffix redactor there would hand the flow a `"[REDACTED]"` string where it
expected its own value (issue #72). `CacheStore.layer` round-trips `result` and
`meta` byte-for-byte.

### RemoteCacheStore and CombinedCacheStore

`RemoteCacheStore` is the same contract spoken over HTTP: `GET`/`PUT`/`DELETE
/ac/{keyDigest}` carrying the `CacheEntry` JSON: mirroring the action-cache
half of Bazel's dumb-HTTP remote cache. `201 Created` is `Inserted`, any other
2xx is `ExistingSame`, `409` is `Conflict`, which is the smallest vocabulary
that preserves first-writer-wins over plain HTTP. A lookup that comes back
recorded under a *different* key is refused: a tier answering with someone
else's entry would hand the caller a result under the wrong key. The endpoint
and its headers are layer construction options: a capability, never an input,
and never part of a step key.

`CombinedCacheStore` composes a local and a remote tier: local first, remote
second, writing the shared entry back into the local SQL store so the next
lookup is local. A local `Conflict` is never published upward. Eviction is
deliberately local-only: every engine eviction is a "this host observed this
row to be poison" judgement, and none of those observations generalize to a
tier where another machine may still hold the artifacts this one lost.

**Publication order is the caller's job.** A cache entry must never be
observable in the shared tier while an artifact it references is missing from
the shared artifact tier; `@smthrs/engine-store`'s `ArtifactSync` enforces that
around `put`. *When* the shared copy is written is the caller's too:
`publication: "deferred"` makes `put` write the local tier only, so a caller
holding a write transaction can publish afterwards rather than hold a network
round trip across it. That is the mode the engine composes, publishing through
its own `CacheSync` seam. See [`@smthrs/artifacts`](/api/artifacts) and
`docs/specs/Concepts/Remote Cache.md`.

### Entry points

The root is written against the driver-neutral `@smthrs/database` service and
bundles for the browser (`pnpm run browser`). The test double binds a Node
SQLite database and is therefore imported from
`@smthrs/step-cache/test/TestCacheStore`. See
[browser support](/architecture/browser-support).

### Migrations

`Migrations.set` is this package's namespaced migration set , 
`flows_step_cache`, and reserves migration id block `2000`. `Migrations.run` /
`Migrations.layer` install it alone; `@smthrs/engine-store/Migrations` composes
it with the journal's, the run store's, and the engine's. See
[`@smthrs/database`](/api/database) for the composition rules.

See `docs/specs/Concepts/Step Keys.md` and the
[`@smthrs/engine-store` reference](/api/engine-store).
