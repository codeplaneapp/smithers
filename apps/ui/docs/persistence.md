# UI persistence

The UI has one logical state machine and two persistence implementations. The
backend changes durability, not collection shape or reducer behavior.

## Backend selection

`createAppStore()` chooses a backend before creating any TanStack collection:

- **OPFS SQLite** is preferred. `SqliteRowStorage.ts` stores one physical row
  per entity and uses a real SQLite transaction for each logical dispatch.
- **localStorage** is the compatibility fallback. `TransactionalStorage.ts`
  stores a versioned envelope and uses a staged write-ahead key so a dispatch
  has one recoverable commit point.
- **memory** is a read/write-isolated degraded session. It is used when the
  recorded OPFS store cannot be opened, so a transient failure cannot fork or
  overwrite the durable conversation.

The selected durable backend is recorded separately in localStorage. Once a
browser has data in OPFS, failure to open OPFS never silently falls back to a
possibly stale localStorage database.

## Collection contract

`PERSISTED_COLLECTION_SPECS` in `state/AppStore.ts` is the authority for every
persisted collection and its Standard Schema validator. Both backends expose
the same `StorageApi` shape to TanStack DB. The store remains the only write
authority: UI components project collections and mutations enter through the
controller/dispatcher.

The durable navigation collections are `app-workspaces`, `app-branches`, and
`app-frames`. Frames refer to existing card records; maximizing a card changes
navigation state rather than copying or remounting the card.

## OPFS SQLite layout

`SqliteRowStorage.ts` owns three tables:

- `smithers_collection_rows(collection_id, row_key, version_key, value)`;
  primary key `(collection_id, row_key)`.
- `smithers_metadata(key, value)` for schema/import bookkeeping and
  non-collection storage keys.
- `smithers_row_quarantine(...)` for rows rejected during validation.

`beginBatch()` buffers the synchronous writes emitted by TanStack collections.
`commitBatch()` schedules exactly one `BEGIN IMMEDIATE` transaction that
inserts, updates, and deletes all changed rows; any error rolls it back.
`AppStore.persist()` awaits `flush()` before reporting persistence complete.

At open, every known row is JSON-decoded and schema-validated. Invalid rows are
moved to quarantine and deleted from the live table in one transaction. A
database stamped with a newer app schema throws `FutureSqliteSchemaError`
before live rows are changed.

The one-time importer reads both historical formats: the `smithers_kv`
envelope and the former `collection_registry` tables. It validates before
copying and leaves source tables untouched for recovery. The metadata stamp
makes import idempotent.

## localStorage fallback

`TransactionalStorage.ts` stores a versioned `smithers-mvp.store` envelope.
A batch writes the new bytes to `.staged`, writes the live key (the commit
point), then removes `.staged`. On boot:

- equal staged/live bytes mean commit completed; the staged marker is cleared;
- different bytes mean commit did not complete; staged bytes are discarded;
- malformed or future-version data is quarantined rather than adopted.

Legacy per-collection keys are migrated through the same schema registry.

## Retention

Compaction is part of the same dispatch as the append. The store keeps the
newest 500 transition records, 250 tool-call records, and 1,000 chain-event
records. Entity collections are not time-trimmed.

## Verification

- `SqliteRowStorage.test.ts`: normalized rows, atomic commit/rollback,
  validation, quarantine, legacy import, and future-version refusal.
- `TransactionalStorage.test.ts`: staged-write crash recovery and migrations.
- `AppStore.test.ts` and controller suites: reducer projections and retention.
- `e2e/playwright/frames.spec.ts`: durable frame URL/history/reload behavior.
