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
| `@smthrs/step-cache` | [src/index.ts](https://github.com/smithersai/flows/blob/main/packages/step-cache/src/index.ts) | any |
| `@smthrs/step-cache/test/TestCacheStore` | [src/test/TestCacheStore.ts](https://github.com/smithersai/flows/blob/main/packages/step-cache/src/test/TestCacheStore.ts) | Node |

## CacheStore

[src/CacheStore.ts](https://github.com/smithersai/flows/blob/main/packages/step-cache/src/CacheStore.ts)

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

[src/CacheStoreMetrics.ts](https://github.com/smithersai/flows/blob/main/packages/step-cache/src/CacheStoreMetrics.ts)

| Export | Kind | Notes |
| --- | --- | --- |
| `lookups` | counter | `flows_step_cache_lookups`, dimensioned by `outcome` |
| `hit`, `miss` | attributed views | `CacheStore.get` updates one per lookup |
| `puts` | counter | `flows_step_cache_puts`, dimensioned by `outcome` |
| `put` | attributed views | keyed by the `PutResult` tag; `conflict` is the signal `Inconsistency` receivers act on |

## RemoteCacheStore

[src/RemoteCacheStore.ts](https://github.com/smithersai/flows/blob/main/packages/step-cache/src/RemoteCacheStore.ts)

| Export | Kind | Notes |
| --- | --- | --- |
| `Options` | interface | `endpoint`, `headers`; a capability, never a step-key input |
| `make`, `layer` | constructor + layer | `GET`/`PUT`/`DELETE /ac/{keyDigest}` over Effect's `HttpClient` |

## CombinedCacheStore

[src/CombinedCacheStore.ts](https://github.com/smithersai/flows/blob/main/packages/step-cache/src/CombinedCacheStore.ts)

| Export | Kind | Notes |
| --- | --- | --- |
| `Options` | interface | the `local` and `remote` tiers, plus `publication: "inline" \| "deferred"` |
| `make`, `layer` | constructor + layer | local-first lookup with write-back into the local SQL store; eviction stays local |

`publication` defaults to `"inline"`, which writes both tiers in `put`. `"deferred"` writes the local tier only and leaves the shared write to the caller. `@smthrs/engine-store` composes this mode and publishes through its `CacheSync` seam once the transaction commits.

:::danger
A write transaction must never span a host call. A caller holding one wants `"deferred"`.
:::

## Migrations

[src/Migrations.ts](https://github.com/smithersai/flows/blob/main/packages/step-cache/src/Migrations.ts)

| Export | Kind | Notes |
| --- | --- | --- |
| `set` | `MigrationSet` | the namespaced set for `flows_step_cache`, in id block `2000` |
| `run` | effect | apply the cache schema |
| `layer` | layer | applies it at construction |

## Test layers

| Export | Source | Notes |
| --- | --- | --- |
| `TestCacheStore.layer` | [src/test/TestCacheStore.ts](https://github.com/smithersai/flows/blob/main/packages/step-cache/src/test/TestCacheStore.ts) | a migrated step cache over in-memory SQLite |
