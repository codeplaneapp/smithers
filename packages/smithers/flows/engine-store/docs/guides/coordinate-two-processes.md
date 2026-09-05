---
title: "Coordinate two processes over one store"
description: "Share a wake bus so a resume does not wait for the next poll, let a follower learn of runs another engine created, and prove cross-process behavior in a test."
sidebar:
  order: 8
---

Two engines over one database do not share memory. Everything they know about
each other comes from rows. This guide covers the three seams that make that
practical: the wake bus that makes same-process resumes immediate, the catalog
read that lets a follower see another engine's runs, and the test composition
that gives you two real connections.

## Share a wake bus inside one process

Polling is the correct fallback and the slow path. `WakeBus` is an in-process,
edge-triggered bus that shortens it:

```ts
import { WakeBus } from "@smthrs/engine-store"

const bus = WakeBus.layer
```

An engine composition resolves the bus optionally. Provide this layer when your
host has its own wake sources, an HTTP handler completing a deferred, say, so
they and the engine share one bus. Provide nothing and the composition builds a
private one.

```ts
import * as Effect from "effect/Effect"

const complete = (executionId: string) =>
  Effect.gen(function*() {
    const wakeBus = yield* WakeBus.WakeBus
    // ... make the durable write first, then announce it.
    yield* wakeBus.wake(executionId)
  })
```

Announce only after the durable write returns. A wake is not durable: with no
waiters it is dropped, and the polling fallback covers the run. Registration is
removed when a waiting fiber is interrupted, including scope closure and losing
a race against the polling sleep, so an abandoned wait leaks nothing.

`WakeBus.layerNoop()` drops every wake, which is what a test asserting the
polling fallback provides. `waiters(executionId)` reports the current count, for
tests and diagnostics: a count observed now says nothing about a moment later.

Cross-process delivery stays store-driven. The other process learns from the
row, not from the bus.

## Let a follower learn of another engine's runs

[`@smthrs/sync`](/api/smithers-sync) serves a workspace subscription over a
`RunCatalog`, and its own implementations are static or in-process, so a
follower composed against one sees the runs that existed when it started and
never learns of another. `RunCatalogRead` is the durable read that fixes that:

```ts
import { RunCatalogRead } from "@smthrs/engine-store"
import * as Effect from "effect/Effect"

const runs = Effect.gen(function*() {
  const catalog = yield* RunCatalogRead.RunCatalogRead
  return yield* catalog.listRunIds({ limit: 500 })
})
```

`RunCatalogRead.layer` provides it and needs `SqlClient`. `listRunIds` returns
the workspace's runs oldest first, bounded by `limit`, which defaults to
`defaultLimit` of 10,000. A workspace with more runs than the bound is followed
by its most recent ones; an older run stays readable through a run-scoped
subscription, which names it directly.

It reads a set rather than a cursor tail on purpose. Retention deletes runs, and
a follower that only ever appended what appeared after a cursor would keep every
collected run in its view forever and hold a journal stream open for each one.

Nothing here polls. The interval belongs to `RunCatalog.makePolling` in
[`@smthrs/sync`](/api/smithers-sync), so the durable side has no policy and no fiber of
its own. `RunCatalogError` carries `invalid_options` (the limit was not a
non-negative safe integer) or `list_failed`; on a failure the caller keeps
whatever view it had, and the next read converges.

## Prove cross-process behavior in a test

Two independently constructed bundles pointed at one file is what a second
process actually looks like: two connections, two engines, no shared object
graph. `test/TestStores.layerAt(filename)` is built for exactly that:

```ts
import * as TestStores from "@smthrs/engine-store/test/TestStores"

const first = TestStores.layerAt("./tmp/shared.db")
const second = TestStores.layerAt("./tmp/shared.db")
```

`layerAt` re-exports the `SqlClient` connection alongside `DurableEngineState`,
because the in-memory variant of that service is a map a second bundle would not
see.

Use a real file. `:memory:` gives each connection its own private database, so
it cannot prove anything durable across compositions. `TestStores.layer` is the
private in-memory bundle, which is right for a case that only needs one engine.

## Give two engines two source ids

Set a distinct `journalSource` per engine so their journal records are
distinguishable, and a distinct `owner.hostId` when they genuinely represent
different hosts. The `OwnerId` nonce already distinguishes incarnations, so two
processes on one host may share a `hostId`.

## Related

- [Durable waits](../concepts/durable-waits.md): the wake, park, and sweep model
  the bus accelerates.
- [Test against a durable store](./testing.md): the rest of the test surface.
- [Sync followers](/docs/guides/sync-followers/) on smithers.sh: the consumer
  side of the catalog read.
