# internal-schema/

Drizzle `sqliteTable` definitions for the internal `_smithers_*` tables, one
table per file, re-exported by `index.js`. They give typed reads/writes through
drizzle; they do NOT create the tables.

- GOTCHA: the authoritative `CREATE TABLE` DDL lives in
  `../sql-message-storage.js` (`CREATE_TABLE_STATEMENTS`). A column change must
  be made in BOTH places (plus a schema migration) or the drizzle model silently
  drifts from the on-disk schema; `tests/db-internal-schema.test.js` guards part
  of this.
- Boolean columns use drizzle `{ mode: "boolean" }` over INTEGER storage (e.g.
  `smithersCron.enabled`, `smithersAttempts.cached`).
- Timestamps are epoch-ms INTEGER columns with an `AtMs` suffix.
- A few tables (`smithersFrames`, `smithersNodeDiffs`, `smithersTimeTravelAudit`)
  declare `ON DELETE CASCADE` foreign keys to `_smithers_runs`.
