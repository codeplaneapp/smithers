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
- A Cloudflare Durable Object SQLite driver under
  `cloudflare/DurableObjectDatabase`, its structural `cloudflare/SqlStorageLike`
  types, and the `test/DurableObjectStorageFake` in-process fake. The rc.0
  contract places Cloudflare engine composition outside core, so treat the
  subpath as provisional.
- `WriteRetryOptions` is re-exported from `DurableWriter`, so the options type
  the public constructors accept has a public name.
- Package-owned documentation: `Package.ts`, `docs/`, and
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
- The Durable Object driver executes a `.raw` statement with result columns once
  rather than twice, and a streamed statement's platform failure arrives as a
  typed `SqlError` instead of an unclassified defect. A platform transaction
  that rejects after the body ran now fails the write instead of reporting
  success.
- The open guard inspects a SQLite `file:` URI filename, which previously
  bypassed the 0.x `smithers.db` refusal, and probes it by path alone so a URI
  carrying `mode=rw` cannot slip past the read-only probe.
- The migration loader rejects an unaligned or unsafe `idOffset` and a local
  migration id outside its block, instead of failing later in a neighbouring
  package. Both diagnostics name the offending key, and two keys in one set that
  realize the same id are reported as the collision they are.

## [0.1.0] - 2026-08-05

### Added

- Added the thin Effect SQL service, Node SQLite layer, in-memory test layer, and bounded transient-write retry policy.
