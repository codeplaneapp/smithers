# store/

The Effect-based persistence layer behind the memory package:

- `MemoryStoreDb.js` — Context tag for the raw drizzle `BunSQLiteDatabase`.
- `MemoryStoreService.js` — Context tag for the `MemoryStore` API.
- `MemoryStoreLive.js` — the Layer implementing every query (facts, threads,
  messages, TTL maintenance).
- `MemoryStore.ts` is the full contract; `MemoryStore.js` is its type-export
  shim; `index.js` is the subpath barrel (`@smithers-orchestrator/memory/store`).

Every operation exists twice: an Effect variant (`*Effect`, typed errors as
`SmithersError` with `DB_QUERY_FAILED`/`DB_WRITE_FAILED` codes, a
`dbQueryDuration` metric sample, and log spans) and a Promise variant that
just `Effect.runPromise`s it.

Factories:

- `createMemoryStoreLayer(db)` provides `MemoryStoreLive` with the db tag.
- `createMemoryStore(db)` runs that synchronously for Promise-land callers
  (tests, CLI).

Gotchas: `setFact` and `saveMessage` are upserts so crash-resume/replay
re-writes don't crash on UNIQUE constraints; `deleteThread` removes messages
and the thread row in one transaction.
