# @smthrs/journal

## [Unreleased]

## [1.0.0-rc.0] - 2026-08-31

### Breaking Changes

- The stores and `SqlJournal` now require Effect's `SqlClient` service plus
  `DurableWriter` (the renamed `Database` service) instead of the bundled
  `Database` service.
- `emitDurable`, `checkpoint`, and `compact` require a well-formed `OwnerId`.
  An omitted, null, or malformed owner fails `invalid_event` instead of
  silently selecting the unfenced write path. `emitDurableUnfenced` is the one
  sanctioned ownerless admission.
- `JournalEvent.RunId`, `JournalEvent.SourceId`, and `Input.eventType` reject
  the empty string and ill-formed UTF-16 at decode. SQLite binds a lone
  surrogate as U+FFFD, so two distinct identifiers collapsed to one persisted
  key and destroyed run isolation.
- `OwnerId.pid` is a non-negative integer. A fractional, `NaN`, or negative
  pid used to degrade into `fence_lost`, which reads as "someone else owns
  this run" and sends the caller hunting a race that never happened.
- Durable read failures report the new `read_failed` code instead of `unknown`,
  which is now reserved for a genuinely unclassified journal defect.
- `payload` and `meta` are encoded with sorted object keys, so producer
  idempotency compares JSON values rather than one serialization of them.

### Added

- `emitDurableUnfenced`, `checkpoint`, `latestCheckpoint`, `compact`, the
  `Checkpoint` and `Compacted` model, and `SqlJournal.CompactionPolicy` for
  automatic threshold-driven checkpoint-and-compact.
- `SqlJournalOptions.sourceEventCache` bounds the in-process
  producer-idempotency index, and `SqlJournalOptions.redact` chooses the
  redactor applied at the single encode chokepoint.
- `TestJournalOptions` forwards `sourceEventCache`, `redact`, and `compaction`,
  so the sanctioned test bundle can exercise every layer option.
- Package-owned documentation under `docs/`, generated into
  `docs/pages/api/journal.md` by `scripts/docs.mjs` and drift-checked by the
  `//packages/journal:docsPages` target.

### Fixed

- `Redaction.defaultRules` covers GitHub tokens, AWS access keys, Slack tokens,
  Google API keys, URL passwords, quoted `KEY="value"` assignments, and
  embedded JSON credential members. The bearer rule consumes the full RFC 6750
  token alphabet instead of stopping at the first `+`, `/`, or `~`.
- `Redaction.redact` mirrors `JSON.stringify`'s `toJSON` step, so a `Date`
  persists as its ISO string instead of `{}`.
- A `Rule` with `replace` omitted now replaces the whole match, as its JSDoc
  always said. It used to emit `"123-45-678=[REDACTED]"` for a match containing
  no `=`, leaking every character but the last.
- A non-global `Rule.pattern` redacts every match instead of only the first.
- `Redaction.redactJsonString` fails closed. It used to return the original
  secret JSON when re-encoding the redacted value failed.
- A payload with a throwing getter, a hostile `Proxy`, or extreme nesting fails
  the emit with a typed `invalid_event` instead of an unrecoverable defect that
  tore down the enclosing `transact` transaction.
- `Journal.stream` emits its first entry after one page instead of
  materializing a run's whole history first.
- A lossy entry admitted before a compaction can no longer land below the
  committed compaction floor, where it was persisted and unreadable forever.
- Automatic compaction runs off the layer-wide allocation permit, so a slow
  `CompactionPolicy.capture` no longer stalls emits on unrelated runs, and
  `capture` is bounded by a timeout.
- `checkpoint`'s receipt is decoded from the bytes it persisted, so it agrees
  with `latestCheckpoint` and no longer aliases the caller's mutable state.
- One conflicted lossy entry no longer destroys its whole persisted batch.
- Entries published to `changes` are frozen, so one subscriber cannot mutate
  another subscriber's view.
- Module headers and the README cite pages that exist. `docs/specs/` was never
  imported into this repository.

## [0.1.0] - 2026-08-05

This release predates the storage split. The run, attempt, and cache stores and
the deferred/clock migration named below moved to `@smthrs/run-store`,
`@smthrs/step-cache`, and `@smthrs/engine-store`; this package's `0002`
migration creates `flows_journal_checkpoints`.

### Fixed

- Kept journal admission, JSON validation, persistence normalization, and
  ownership heartbeat loss in typed Effect failure/interruption channels.
- Replaced structural `_tag` probing with Schema and Effect SQL error guards.

### Added

- Added the non-blocking journal, fenced run and attempt stores, run
  coordinator, migrations, and content-addressed cache.
- Added migration 0002 for durable deferred completions and absolute clock
  deadlines.
