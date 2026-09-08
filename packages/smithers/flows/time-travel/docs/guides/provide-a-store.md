---
title: "Provide a store"
description: "Choose and wire a TimeTravelStore: the in-memory reference implementation, the SQLite-backed durable one, and the migration ladder a composition that owns its schema should use instead."
sidebar:
  order: 4
---

`TimeTravelStore` is the only contract this package defines, and the only
service `TimeTravel.layer` requires that an engine composition does not already
provide. It is the one thing that knows how a run's past is stored: it answers
what the anchors, state, and attempts were at a frame, and it owns the three
mutations time travel performs.

Two implementations satisfy it, and they are behavioural peers rather than a
real one and a lesser one: a run inspected under either must be inspected
identically.

## The durable store

`SqlTimeTravelStore` is the one to run in production:

```ts
import { SqlTimeTravelStore, TimeTravel } from "@smthrs/time-travel"
import * as Layer from "effect/Layer"

const layer = TimeTravel.layer.pipe(Layer.provideMerge(SqlTimeTravelStore.layer))
```

It requires a `SqlClient` and a `DurableWriter` from
[`@smthrs/database`](/api/database). Writes go through the durable writer
rather than straight to the client, so a rewind's audit row, its receipts, and
its truncation land under the same durability discipline as the engine's own
journal writes.

Building the layer runs `SqlTimeTravelStore.migrate` first, so a fresh database
is usable with no separate setup step. It creates six tables and the index
under them:

| Table                            | What it holds                                                      |
| -------------------------------- | ------------------------------------------------------------------ |
| `flows_time_travel_snapshots`    | The anchors at a frame: the Jujutsu pointer and the plan digest.   |
| `flows_time_travel_edges`        | The fork edges of the lineage tree.                                |
| `flows_time_travel_audits`       | One row per rewind, so a crash leaves something recovery can find. |
| `flows_time_travel_receipts`     | Proof that a side effect was compensated.                          |
| `flows_time_travel_archive`      | The records a truncation moved aside rather than deleted.          |
| `flows_time_travel_fork_intents` | A minted fork id, reserved before its workspace is provisioned.    |

It also indexes `meta_json.lineageId` on the journal's own
`flows_journal_events`, so a lineage-filtered read is not a full run scan.

**The store is SQLite dialect only.** Its DDL uses `typeof()` and `json_valid`
CHECK constraints, and its reads use `json_extract` with `$` paths. Any
SQLite-speaking `SqlClient` runs it, whether wa-sqlite, libsql, or the Node or
Bun built-in. PostgreSQL and MySQL are unsupported; a portable dialect would
require a redesign. Archive writes use strict `INSERT` keyed by
`(run_id, generation, seq)`; a collision rolls back the archive transaction.

## Run the migrations on the shared ladder

A composition that already runs a migrator should not let the store create its
own tables on the side. `Migrations` publishes the same schema as a rung on the
shared ladder, recorded in `flows_migrations` like every other package's:

```ts
import { Migrations } from "@smthrs/time-travel"

const migrated = Layer.provideMerge(Migrations.layer, database)
```

`Migrations.set` is time travel's own set at id block `5000`. `Migrations.sets`
is the complete durable schema for an engine with time travel: everything
[`@smthrs/engine-store`](/api/engine-store) composes, then this.
`Migrations.run` applies them in order, and `Migrations.layer` installs them
before exposing the database.

The block number is not arbitrary. Migration ids are spaced by 1,000, and a
migrator runs from a single high-water mark: it refuses any migration whose id
sits below the mark the database already applied rather than skipping it
silently. This set therefore ships above every set an engine composition
already applies, which is what lets it add an index to a table the journal
owns. The table stays the journal's; only the index does not.

## The in-memory store

`MemoryTimeTravelStore` holds everything in JavaScript objects. It is
deterministic, needs no database, and works in the browser, which makes it the
store every test in this package runs against:

```ts
import { MemoryTimeTravelStore, TimeTravel } from "@smthrs/time-travel"

const layer = TimeTravel.layer.pipe(Layer.provideMerge(MemoryTimeTravelStore.layer()))
```

`MemoryTimeTravelStore.make(options)` returns the same store widened with a
`state()` inspector, which is what a test holds when it needs to assert on
archived records or surviving edges. See
[Test against history](./testing.md).

## Write your own

The contract is an ordinary interface. Write the implementation against
`TimeTravelStore.Service`, then pass it through `TimeTravelStore.make`, which
brands it so a new backend is checked at its definition site rather than at the
layer:

```ts
import { TimeTravelStore } from "@smthrs/time-travel"
import * as Layer from "effect/Layer"

declare const implementation: TimeTravelStore.Service

const layer = Layer.succeed(TimeTravelStore.TimeTravelStore)(TimeTravelStore.make(implementation))
```

Hold a new backend to the same answers the two shipped ones give. The reads
reconstruct a frame's past, the audit trio makes an in-flight rewind
recoverable, and `archiveAndTruncate`, `createFork`, and `recordReceipt` change
the lineage tree. Two behaviours are easy to get wrong and are worth stating:

- `archiveAndTruncate` is **fenced**. It re-checks the run's recorded owner and
  every non-terminal attached child's exact owner inside the same transaction,
  and refuses the whole mutation with `fence_lost` on a mismatch.
- `nextForkId` **reserves** the id it mints. The reservation is what makes a
  crashed fork retryable under a fresh lane name instead of colliding with the
  leftover on disk.

## Where to go next

- [Installation](../installation.md): the other four services the layer needs.
- [Test against history](./testing.md): seeding a store and asserting on what
  an operation did.
- [API reference](../api.md): every method of `TimeTravelStore.Service`.
