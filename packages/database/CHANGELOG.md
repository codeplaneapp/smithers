# @smthrs/database

## [Unreleased]

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

### Changed

- A `write` nested inside the client's open transaction now joins it as a
  savepoint without its own retry; only the outermost transaction replays a
  transient conflict.
- The retry classifier follows `cause` chains, so a domain error wrapping a
  transient SQL failure keeps the outermost transaction replaying.

## [0.1.0] - 2026-08-05

### Added

- Added the thin Effect SQL service, Node SQLite layer, in-memory test layer, and bounded transient-write retry policy.
