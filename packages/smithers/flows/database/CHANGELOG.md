# @smthrs/database

## [Unreleased]

## [1.0.0-rc.0] - 2026-08-31

### Breaking Changes

- Renamed the `Database` service to `DurableWriter` and removed its `sql`
  member: queries go through Effect's own `SqlClient` service, and the writer
  exposes only `write`. `DurableWriter.layer(options?)` composes over the
  context's `SqlClient`.
- `NodeDatabase.layer` now provides only the `SqlClient` (connection options
  only); retry tuning moved to `DurableWriter.layer`. `TestDatabase.layer`
  provides both the client and the writer.
- Removed the `unsupportedSql` proxy from `makeNoop`; the noop writer only
  fails `write` with `unsupported`.
- Removed the provisional Cloudflare Durable Object adapter and its Node fake.
  Real workerd rejects `SAVEPOINT`, so it cannot satisfy `DurableWriter`'s
  nested-write contract for arbitrary suspending Effects. Cloudflare engine and
  storage hosting remain outside 1.0.0-rc.0 core.

### Added

- `NodeDatabase.layer` refuses three opens before it creates a connection and
  raises `UnsupportedDatabase` as a defect for each: `unsupported_runtime` under
  Bun, `unsupported_database_file` for a 0.x `smithers.db`, and
  `database_locked` for a file a peer held for the whole open ladder.
  `UnsupportedDatabaseCode` and `isUnsupportedDatabase` are exported with them.
- `UnsupportedBackend.ignoredNames` and `UnsupportedBackend.ignoredNotice`
  report the `SMITHERS_TEST_PG_URL` and `SMITHERS_POSTGRES_*` names 1.0.0-rc.0
  ignores, so a project migrating from PostgreSQL is not left believing it ran
  against one.
- `Migrations` composes per-package migration sets over the single
  `flows_migrations` table, with `table`, `idBlock`, `MigrationSet`, `loader`,
  `run`, and `layer`.
- `DatabaseMetrics.writeRetries` counts write transaction replays as
  `flows_db_write_retries`.
- `WriteRetryOptions` is re-exported from `DurableWriter`, so the options type
  the public constructors accept has a public name.
- Package-owned documentation: `docs/Manifest.ts`, `docs/`, and
  `scripts/docs.mjs` generate `docs/pages/api/database.md`.

### Changed

- A `write` nested inside the client's open transaction now joins it as a
  savepoint without its own retry; only the outermost transaction replays a
  transient conflict.
- The retry classifier follows `cause` chains, so a domain error wrapping a
  transient SQL failure keeps the outermost transaction replaying.
- Retry exhaustion now surfaces the original `Cause` rather than a single
  extracted value, so a defect stays a defect, an interrupt stays an interrupt,
  and a parallel non-database failure is no longer discarded.
- A typed failure must carry an Effect `SqlError` in its cause chain to be
  retried, so an application error whose message quotes database text is no
  longer replayed. The Effect 4.0.0-rc.108 rollback defect stays matched on the
  defect channel.
- `fromSqlError` and `isRetryableWriteError` read one classifier, so the whole
  SQLite busy vocabulary normalizes to `busy` instead of retrying under a code
  that reports `unknown`, and an I/O failure that carries a busy cause beneath
  it is reported as `io` and never replayed, in either nesting order.
- The retry decision reads every reason a `Cause` carries, so a parallel failure
  that pairs a transient SQL error with an application error replays whichever
  half arrived first.
- `affectedRows` accepts an exact `bigint` count, which is what `node:sqlite`
  returns under `SqlClient.SafeIntegers`, reads only own data properties, and
  reports the shape of an unreadable result rather than attaching the result
  itself to the error.
- The open guard inspects a SQLite `file:` URI filename, which previously
  bypassed the 0.x `smithers.db` refusal, and probes it by path alone so a URI
  carrying `mode=rw` cannot slip past the read-only probe.
- The migration loader rejects an unaligned or unsafe `idOffset` and a local
  migration id outside its block, instead of failing later in a neighbouring
  package. Both diagnostics name the offending key, and two keys in one set that
  realize the same id are reported as the collision they are.

### Fixed

- `Migrations.run` decodes applied migration ids by value, so the idempotent
  re-run under `SqlClient.SafeIntegers` no longer dies converting a `bigint`,
  and an unreadable `migration_id` fails as a `BadState` `MigrationError`
  naming the value instead of a raw `TypeError`. `MigrationSet.migrations` is
  `Readonly`, and the loader snapshots the plan when it is built, so mutating
  the record after `run` returned its Effect cannot change which migrations
  execute.
- An I/O failure anywhere in a parallel `Cause` now vetoes the replay
  cause-wide, so a write that raced an I/O failure against a busy conflict is
  never replayed, in either arrival order. Retry classification no longer
  executes arbitrary error property getters, so a throwing `code`, `message`,
  or `cause` accessor keeps the typed failure on the typed channel instead of
  replacing it with a defect.
- The open guard skips the file probe for a SQLite `mode=memory` URI, which
  names a pure in-memory database, so a memory-mode name that collides with an
  on-disk 0.x file is no longer refused.
- README links to repository documentation are absolute, so they resolve on
  npm.
- The generated entry-point table lists the root-module subpaths
  (`DurableWriter`, `DatabaseMetrics`, `Migrations`), and `docs.mjs --check`
  fails when a module the `./*` export map publishes is missing from
  `docs/Manifest.ts` entries.

## [0.1.0] - 2026-08-05

### Added

- Added the thin Effect SQL service, Node SQLite layer, in-memory test layer, and bounded transient-write retry policy.
