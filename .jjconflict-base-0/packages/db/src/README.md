# @smithers-orchestrator/db — src

The Smithers persistence layer. Two layers do the work: `sql-message-storage.js`
(raw SQL over bun:sqlite/PGlite/Postgres with snake/camel mapping and dialect
translation) wrapped by the `SmithersDb` adapter (`adapter.js` — Effect-based
per-client read/write serialization, SQLite write retries, txid capture for
Electric sync, metrics/log spans). `dialect.js` is the single SQLite ↔ PostgreSQL
seam (placeholders, DDL types, BEGIN style, identifier quoting, json_extract);
`internal-schema.js` catalogs every internal `_smithers_*` table as Drizzle
definitions, and `schema-migrations.js` is the versioned migration ledger shared
by both dialects.

User-facing run data: `zodToTable.js` / `zodToCreateTableSQL.js` turn a
workflow's Zod schemas into input/output tables (`assertNoReservedColumns.js`
guards `run_id`/`node_id`/`iteration` collisions); `output.js` and `snapshot.js`
read/write those rows dialect-agnostically (`snapshot.js` holds the canonical
Postgres-aware `loadInput`/`loadOutputs` and their Effect forms).
`input-bounds.js` re-exports the `assert*.js` validator family used by
gateway/engine/sandbox input guards — the one-function-per-file split there is
deliberate.

Frames and state: `frame-codec.js` encodes `_smithers_frames` as keyframes plus
JSON deltas (`FRAME_KEYFRAME_INTERVAL` bounds replay); `runState.js` re-exports
the `runState/` derivation used by ps/monitor surfaces; `docWatcher.js` +
`sha256Hex.js` reconcile on-disk `*.md` docs into `_smithers_docs` with
tombstone-respecting last-write-wins.

Gotchas: `index.js` is the barrel, but package.json's `./*` export makes every
src file deep-importable (e.g. `@smithers-orchestrator/db/docWatcher`,
`/buildHumanRequestId`, `/react-output`) — do not rename files casually. The
`adapter/`, `frame-codec/`, `internal-schema/`, `output/`, `runState/`
directories hold the type sidecars and split implementations behind the
same-named single files; those single files are the live import surface.
