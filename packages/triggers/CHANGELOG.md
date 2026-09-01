# Changelog

## [1.0.0-rc.0]

### Added

- Added Effect Cron-backed declarations, overlap and bounded catch-up
  policies, durable CAS fire claims, a scoped scheduler, authority-free
  channels, and verified raw-byte webhooks.

### Changed

- A fire claim now carries `expectedRevision` and reads the overlap policy,
  `enabled`, and `revision` inside the claim transaction, so a caller holding a
  declaration snapshot from before an edit is refused with `revision_mismatch`
  or `trigger_disabled` instead of firing it.
- `TriggerStore.due(now)` is now `TriggerStore.listEnabled()`. The parameter was
  accepted and discarded; due-ness is a cron computation the scheduler performs
  against its own watermark.
- A webhook `credential` is required and is forwarded to `Channel.Verify` and to
  `Webhook.SignatureConfig.expected` on every request, so a signing secret is
  resolved through the host resolver rather than captured in a closure at
  declaration time. `expected` returns an Effect, so a resolution or HMAC
  failure is a typed `verification_failed` rather than a defect.
- `Webhook.ingest` copies `body`, `headers`, and `idempotencyKey` before
  verification, so verification, delivery fingerprinting, and decoding all read
  one private snapshot. It no longer registers the channel on every request;
  registration is `Webhook.register`.
- `Webhook.constantTimeEqual` iterates over the expected signature's length
  rather than the longer of the two inputs, so its work is fixed by the secret
  side of the comparison.
- Error codes gained `runner`, `invalid_options`, `trigger_disabled`, and
  `revision_mismatch`, and `TriggerError` gained `path`. A declaration failure
  names its offending field and summarizes the schema issue tree instead of
  carrying a five-kilobyte AST as its cause.
- `last_fired_at_ms` only ever moves forward, so an older run settling after a
  newer occurrence was skipped no longer replays settled work.
- Scope closure detaches run monitors instead of cancelling them: scheduled runs
  are durable and the next incarnation re-attaches to them.
- `Cron.occurrencesBetween` caps an unstated limit at `Cron.maxOccurrences` and
  refuses a limit that is not a non-negative safe integer.
- `Schedule.maxCatchUp` defaults to `0` and is bounded above by
  `Schedule.maxCatchUpLimit`. Every catch-up policy answers to it, `one`
  included.

### Fixed

- A run held at Control's `accepted` status is no longer recorded as completed
  on the next poll, which had released the overlap guard for a run that had not
  started.
- A newly registered trigger no longer fires an arbitrarily stale past
  occurrence under `catchUp: "none"`; its first sight establishes the watermark.
- A launch reservation recovered from the store is no longer cleared on the
  following tick before its lease expires.
- The occurrence watermark advances only past occurrences this process finished
  dispatching, and a buffered occurrence taken from the row is re-armed when the
  claim or dispatch that followed it failed.
- `TriggerStore` failures no longer collapse into `store`: a typed refusal the
  store raised travels out unchanged, and every missing-row path in both the SQL
  store and the in-memory test layer fails with `unknown_trigger`.
- A parked plan is re-offered a bounded number of times rather than once a
  second for the life of the scope, and a scheduler poll interval must be finite
  and positive.

### Removed

- `@smthrs/triggers/migrations/*` is no longer a public subpath. The intended
  entry point is `SqlTriggerStore.layer`, which applies both migrations in
  order.
