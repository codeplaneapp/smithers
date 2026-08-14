# 🐛 smithers: [low] pg.types.setTypeParser(20, Number) mutates the host process global BIGINT decoding

GitHub: https://github.com/smithersai/smithers/issues/668

_via ultracode (Opus multi-agent) review_

**Summary:** Opening any Postgres/PGlite backend globally overrides node-postgres' BIGINT (oid 20) decoding to a lossy `Number()`, corrupting BIGINT reads for unrelated `pg` clients in the same process.

**Locations:**
- `packages/smithers/src/create.js:572` — `pg.types.setTypeParser(20, (value) => (value === null ? null : Number(value)));`
- `packages/smithers/src/openSmithersStore.js:105` — identical call.

**Why it's a bug:** `pg.types` is the process-global singleton (`pg-types`) shared by every `pg.Client`/`Pool`. node-postgres deliberately returns int8/BIGINT as a *string* to preserve full 64-bit precision; this override replaces that behavior for the entire process, not just smithers' own connection.

**Failure scenario:** A host application embeds `smthrs` and also uses `pg` for its own DB, reading a BIGINT id above 2^53 (e.g. `9007199254740993`). Before smithers opens a Postgres backend the app reads the exact string; afterward the same query silently returns `9007199254740992` (`Number("9007199254740993") === 9007199254740992`) — data corruption with no error, in code smithers doesn't own.

**Fix:** Register the coercion per-client instead of globally — pass a client-scoped `types` object (`{ getTypeParser }`) to the `pg.Client` constructor so only smithers' own connections coerce oid 20, leaving the shared `pg.types` registry untouched.
