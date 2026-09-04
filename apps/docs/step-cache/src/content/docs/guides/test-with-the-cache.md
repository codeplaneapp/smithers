---
title: "Test against the step cache"
description: "Test code that depends on the step cache: the migrated in-memory store, a controlled clock for age bounds, the noop store for units that must not reach it, a stubbed shared tier, and counter assertions."
sidebar:
  order: 8
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/step-cache/docs/guides/test-with-the-cache.md"
---

Every input the store depends on is a service, so a test swaps the service
rather than the code under test. The database, the clock, and the shared tier
each have a seam this package ships.

## Use the real store over an in-memory database

`@smthrs/step-cache/test/TestCacheStore` is the production SQLite store with
migrations already run, over a database that is never written to disk. Nothing
is stubbed, so a test proves the behavior production has:

```ts
import { describe, expect, it } from "@effect/vitest"
import * as CacheStore from "@smthrs/step-cache/CacheStore"
import * as TestCacheStore from "@smthrs/step-cache/test/TestCacheStore"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"

const entry: CacheStore.CacheEntry = {
  keyDigest: "compile-server-v1",
  result: { artifact: "dist/server.js" },
  meta: { durationMs: 1_820 },
  createdAtMs: 0,
  recordedRunId: "run-a",
  recordedEventSeq: 7
}

describe("the step under test", () => {
  it.effect("reuses a recorded result", () =>
    Effect.gen(function*() {
      const cache = yield* CacheStore.CacheStore
      expect(yield* cache.put(entry)).toEqual({ _tag: "Inserted" })
      expect(Option.isSome(yield* cache.get(entry.keyDigest))).toBe(true)
    }).pipe(Effect.provide(TestCacheStore.layer)))
})
```

The layer binds a Node SQLite database, which is why it lives at its own
subpath instead of in the root namespace set. It is Node only.

When a test also needs the `SqlClient` itself, to assert on rows directly,
compose the pieces rather than the bundle: `CacheStore.layer` over
`Migrations.layer` over `TestDatabase.layer` from
[`@smthrs/database`](https://database.smithers.sh/reference/api/) leaves the client in scope.

## Control the clock for age bounds

`maxAgeMs` and `sweepExpired` both read the injected clock, so a test states
the passage of time outright and never waits:

```ts
import { TestClock } from "effect/testing"

it.effect("refuses a result older than the bound", () =>
  Effect.gen(function*() {
    const cache = yield* CacheStore.CacheStore
    yield* cache.put(entry)
    yield* TestClock.adjust("1 second")
    expect(Option.isSome(yield* cache.get(entry.keyDigest, { maxAgeMs: 1000 }))).toBe(true)
    yield* TestClock.adjust("1 millis")
    expect(Option.isNone(yield* cache.get(entry.keyDigest, { maxAgeMs: 1000 }))).toBe(true)
  }).pipe(Effect.provide(TestCacheStore.layer), Effect.provide(TestClock.layer())))
```

An entry recorded exactly at the bound is served, and one millisecond past it
is a miss. `sweepExpired` uses the same boundary, so a row recorded exactly at
the floor survives the sweep.

## Refuse the operations a unit should never reach

`CacheStore.layerNoop` provides a store whose every operation fails with
`unknown` and a message naming the method. A test that reaches an operation it
did not supply is told which one, instead of reading a silent miss that makes
the test pass for the wrong reason:

```ts
import * as CacheStore from "@smthrs/step-cache/CacheStore"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"

const readOnly = CacheStore.layerNoop({
  get: () => Effect.succeed(Option.none())
})
```

That composition serves every lookup as a miss and fails the test the moment
anything records, evicts, or sweeps. `CacheStore.makeNoop` is the same thing as
a value, for a composition that wants the service rather than the layer.

## Stub a shared tier

The shared tier is just another `CacheStore.Service`, so a two-tier test needs
no HTTP at all:

```ts
import * as CombinedCacheStore from "@smthrs/step-cache/CombinedCacheStore"

const remote: CacheStore.Service = {
  get: () => Effect.succeed(Option.some(entry)),
  put: () => Effect.succeed({ _tag: "ExistingSame" }),
  evict: () => Effect.succeed(false),
  sweepExpired: () => Effect.succeed(0)
}

const twoTier = Effect.gen(function*() {
  const local = yield* CacheStore.CacheStore
  return CombinedCacheStore.make({ local, remote })
})
```

Use it to prove the composition's decisions: that a local hit never touches the
shared tier, that a shared hit is written back locally, that `"deferred"` mode
leaves the shared write alone, and that `evict` and `sweepExpired` stay local.

To exercise the real HTTP client without a server, provide an `HttpClient` your
test builds with `HttpClient.make` and pass it to `RemoteCacheStore.make`. That
is how this package tests its own status mapping, its body bounds, and its
query parameters.

## Assert on the counters

Provide an isolated registry so counts from other tests in the same process do
not leak in, then read the attributed views:

```ts
import * as CacheStoreMetrics from "@smthrs/step-cache/CacheStoreMetrics"
import * as Metric from "effect/Metric"

const count = (metric: Metric.Metric<number, Metric.CounterState<number>>) =>
  Effect.map(Metric.value(metric), (state) => state.count)

it.effect("counts the miss and the recording", () =>
  Effect.gen(function*() {
    const cache = yield* CacheStore.CacheStore
    yield* cache.get(entry.keyDigest)
    yield* cache.put(entry)
    expect(yield* count(CacheStoreMetrics.miss)).toBe(1)
    expect(yield* count(CacheStoreMetrics.put.Inserted)).toBe(1)
  }).pipe(
    Effect.provide(TestCacheStore.layer),
    Effect.provideService(Metric.MetricRegistry, new Map())
  ))
```

Assert on `hit`, `miss`, and the `put` views, never on the bare `lookups` and
`puts` handles: every update carries an `outcome` attribute, so the
unattributed handles read zero. See
[observe cache outcomes](/guides/observe-cache-outcomes/).

## Where to go next

- [Compose a durable step cache](/guides/compose-a-store/): the same store over a
  real file.
- [Quickstart](/quickstart/): a whole cache cycle against the in-memory
  store.
