---
description: "The durable event journal and the run, attempt, and cache stores beside it: semantics, invariants, and ordering."
---

# Journal

This page explains the durable event journal in `@smthrs/journal` and the adjacent run, attempt, and cache stores in `@smthrs/run-store` and `@smthrs/step-cache`. It focuses on semantics and invariants; the [package reference](/api/journal) lists exact exported types.

## Open event envelope

A submitted event contains:

```ts
const input = Schema.decodeUnknownSync(JournalEvent.Input)({
  runId: "run-42",
  sourceId: "worker-a",
  sourceSeq: 0,
  eventType: "example.completed",
  payload: { value: 42 },
  meta: { lineageId: "root" }
})
```

The journal does not define an application-wide event union. `eventType`, `payload`, and `meta` remain open so engine, permission, time-travel, and application events share one ordering substrate.

## Two sequence domains

Each committed entry has:

- `seq`: canonical order within one run;
- `sourceSeq`: producer-local idempotency order within `(runId, sourceId)`.

`makeEventId(runId, sourceId, sourceSeq)` deterministically encodes the producer identity. An exact retry returns `Duplicate` with the original `seq`. Reusing that identity with different event content fails with `idempotency_conflict`.

There is no global order across runs.

## The journal is intended to be flows' authoritative logical WAL

The journal is flows' own logical (domain) write-ahead log: run decisions, attempt lifecycle, deferred completions, clock schedules, permission decisions, and cache provenance. It is intended to become the authoritative state history. The SQLite or PostgreSQL WAL underneath it is only the storage durability substrate; it is never read as the application event API.

The rule that follows is that **a durable boundary may not advance the run or expose its result until the corresponding logical WAL entry is committed**. `emitDurable` allocates inside the write transaction and returns a receipt that is already committed.

A local commit is not remote atomicity. No journal write makes an external effect atomic with it, so effects outside the database still carry idempotency keys, fencing tokens, or a declared compensation.

## Optimistic admission (only telemetry may accept loss)

`SqlJournal.emitLossy` validates, allocates both sequences, and attempts a non-blocking bounded queue offer. It returns before SQL commits.

An `Accepted` receipt from that queue means only that the event entered the writer queue. It does not mean the row is durable, and a crash can lose it. `emitLossy` is **lossy by construction and off the critical path**; nothing may be reconstructed from it and no correctness argument may cite it. Lifecycle callers use `emitDurable`.

Overflow policy is explicit:

| Policy | Full queue behavior |
| --- | --- |
| `reject` | fail with `queue_overflow` |
| `drop-newest` | return `Dropped` |
| `drop-oldest` | evict one queued event and return `Accepted` with eviction evidence |

Rejected and dropped admissions consume sequence numbers, so gaps are valid. Consumers must follow declared covered intervals rather than assuming adjacent persisted entries have adjacent sequence values.

## Writer and streams

A single scoped writer persists batches transactionally through `DurableWriter.write`. Committed inserts publish to:

- the general `changes` subscription;
- per-run wake channels used by `stream`.

`Journal.stream({ runId, afterSequence })` first reads durable history, then follows committed changes. `project` scans that same stream with an effectful deterministic reducer. Projections have no separate durable state.

## Run store

`RunStore` is synchronous control state, not an event-derived projection. Its compare-and-swap outcomes make contention explicit:

- claim and activation;
- generation-fenced claim abandonment and stale-claim recovery;
- owner heartbeat;
- owned status transition;
- stale-owner steal with liveness evidence.

Ownership decisions write rows directly. Journal events may describe those decisions, but the journal is not consulted to decide who owns a run.

## Attempt store

An attempt address is `(runId, stepKeyDigest, attempt)`. Mutations are fenced by the currently running run owner.

Attempt heartbeats may include a JSON checkpoint up to 1 MiB. Omitting a checkpoint preserves the previous checkpoint. The first fenced terminal transition wins; later finish calls observe `StateChanged`.

## Cache store

`CacheStore` maps a digest to a JSON result, opaque JSON metadata, creation time, and journal provenance. Writes are first-writer-wins:

- equal content → `ExistingSame`;
- different content → `Conflict`;
- no row → `Inserted`.

`@smthrs/engine-store` decodes the step key through the injected `Sha256` transformation to obtain the cache address. It admits only hard, deviation-free sealed boundaries.

## Migrations

`Migrations.run` creates:

- `flows_journal_events`;
- `flows_runs`;
- `flows_attempts`;
- `flows_step_cache`;
- `flows_deferred_completions`;
- `flows_clock_deadlines`;
- migration bookkeeping.

Time-travel tables use a separate migration in `@smthrs/time-travel`.

## State authority, and how the log stays consistent with it

`RunStore`, `AttemptStore`, `CacheStore`, and `DurableEngineState` hold the **executable authoritative state**. No engine state is derived from journal entries; the entries explain what happened, the rows decide what happens next.

The two are nevertheless committed together. Engine-store writes every lifecycle event with `emitDurable` **inside `Journal.transact`**, the write transaction that also carries the state transition it describes: the run-row compare-and-swap with its decision, the attempt write with its attempt event. Those stores use the same `DurableWriter`, so their writes join that transaction as savepoints: either both halves are durable, or neither is. A crash can no longer leave durable state the journal does not explain, which is what lets audit, sync, and time travel treat the log as the account of record.

Of the two shapes this could have taken, deriving the store rows from the log, or committing the state projection and its entry in one transaction, Smithers took the second. It is the smaller change: the executable rows keep their fenced CAS semantics, and no read path has to be rebuilt on projection.

Two consequences to plan for. Publication follows the commit, so an entry becomes visible on `changes`/`stream` only after the outermost transaction commits. And the unit is all-or-nothing: a crash before COMMIT loses the whole unit, so work that had already run, an action body, for instance, re-executes on the next drive. Local commit is still not remote atomicity: external effects need idempotency keys, fencing tokens, or compensation.

## Operational rule

Use `emitLossy` only for telemetry where a drop is acceptable. Put anything that authorizes work or is required for recovery on `emitDurable`. A dropping queue cannot serve as the durable source of permission grants, deferred completion ordering, or time-travel audit.
