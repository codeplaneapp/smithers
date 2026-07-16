# store/

The Effect-based persistence layer behind the memory package:

- `MemoryStoreDb.js` — Context tag for the raw drizzle `BunSQLiteDatabase`.
- `MemoryStoreService.js` — Context tag for the `MemoryStore` API.
- `MemoryStoreLive.js` — the Layer implementing every query (facts, threads,
  messages, TTL maintenance).
- `HindsightMemoryStore.js` — Hindsight semantic projection/runtime over
  `@vectorize-io/hindsight-client`, with exact records delegated to a
  transactional `MemoryStore`.
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
- `createHindsightMemoryStore({ ..., contractStore })` creates the Hindsight
  implementation while preserving the exact store's atomic/global contract.

Hindsight mapping:

- A Smithers namespace selects a prefixed Hindsight bank. Stable user labels
  remain tags; run and session ids are retained as metadata.
- Facts use a stable document id derived from namespace + key and retain with
  `updateMode: "replace"`, preserving exact-key upsert semantics.
- Threads, messages, and notes are typed retained documents. Message retries
  replace the same document; engine turn/task retention uses one stable
  per-run document id with `updateMode: "append"`.
- `searchNotes` and engine recall call Hindsight `recall`. Compound filters use
  `tag_groups` exclusively because the Hindsight client rejects requests that
  combine `tags` with `tag_groups`.

Gotchas: `setFact` and `saveMessage` are upserts so crash-resume/replay
re-writes don't crash on UNIQUE constraints; `deleteThread` removes messages
and the thread row in one transaction.
