# 🐛 memory: [low] deleteThread's sync sqlite transaction has no backend guard, degrades to obscure TypeError on Postgres/PGlite

GitHub: https://github.com/smithersai/smithers/issues/714

_via ultracode (Opus multi-agent) review_

## Summary
`deleteThreadEffect` uses the synchronous bun:sqlite-only `db.transaction(tx => { ...run() })` pattern with no `requireSqlite` guard, so on a Postgres/PGlite drizzle db it throws a raw driver `TypeError` while every sibling thread/message/fact operation works.

## Location
- `packages/memory/src/store/MemoryStoreLive.js:262-274` (transaction at 266, `.run()` at 269/272)
- Contrast: `requireSqliteNotesEffect` guard at `packages/memory/src/store/MemoryStoreLive.js:388-393`, applied to the note sync-transactions at lines 466 and 542.

## Failure scenario
When a `MemoryStore` is constructed over a Postgres/PGlite drizzle db (a contemplated input — see the `dialect === "postgres"` check at line 390, migration 0023 creating note tables on Postgres, and the `smithers migrate` command), `createThread`/`saveMessage`/`setFact` succeed because they use plain awaited drizzle (`onConflictDoUpdate`). But `deleteThread` calls `tx.delete(...).where(...).run()` — pg/pglite drizzle query builders expose no synchronous `.run()`, so it throws `tx.delete(...).run is not a function`.

## Why it matters
Inconsistent portability contract. The notes path goes out of its way to fail loud with a clear "memory notes require the sqlite backend" message — its comment (lines 378-383) explicitly says the guard exists to avoid "surfacing an obscure driver TypeError mid-write." `deleteThread` silently degrades to exactly that obscure TypeError. Fix: either guard `deleteThread` with the same `requireSqlite` check, or rewrite it to two awaited standard drizzle deletes (optionally in an async transaction) so it works on all backends.
