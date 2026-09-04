# @smthrs/observability

## [Unreleased]

## [1.0.0-rc.0] - 2026-09-01

### Added

- Effect-native OTLP export, structured logger layers, validated OpenTelemetry
  resource metadata, provider-neutral SDK bridges, and explicit Node and
  browser SDK subpaths.
- A bounded, asynchronous journal logger with versioned cause payloads,
  durable journal-owned identities, synchronous detached snapshots, and the
  shared credential-redaction rules.
- Package-owned generated README and API documentation.
- Producer-wired run throughput, active seat, and quota park metrics.
- A `droppedLogRecords` counter for every operational log record lost to queue
  overflow, journal delivery failure, or a journal defect.
- An `Endpoint` module that decodes and normalizes the collector endpoint every
  OTLP builder posts to.

### Changed

- Removed duplicate cache hit, miss, and hit-rate handles; the authoritative
  cache series remain in `@smthrs/step-cache`.

### Fixed

- Recreated or concurrent journal logger layers no longer reuse `sourceSeq`
  identities and silently lose records.
- Queued records no longer observe later caller mutation or discard Effect
  failure, defect, and interruption causes.
- All resource builders now reject the same malformed identities, Unicode,
  attribute keys, values, and resource sizes with one typed error.
- Logger capacity, identifier, snapshot, overflow, and shutdown behavior is
  explicit and covered at its exact boundaries.
- A logged value large enough to spend the snapshot budget no longer turns
  `annotations` into a scalar, and a projection that still fails `TelemetryLog`
  degrades to a decodable total record instead of an undecodable journal row.
- Journal delivery failures and journal defects are reported as warnings and
  counted instead of vanishing, and a defect no longer ends the forwarding
  worker for the rest of the run. Interruption still ends it.
- Snapshot truncation runs in one pass instead of about twenty re-encodes and
  never cuts a surrogate pair.
- An unusable collector endpoint fails layer acquisition instead of producing a
  layer that exports nothing, and repeated trailing separators no longer
  produce a double slash in a signal URL.
- The logger layers no longer pin the application's `MinimumLogLevel` when the
  caller named no level.

### Documentation

- Corrected the reason `NodeOtel` cannot be re-exported from the root barrel:
  it resolves Node-only host modules, including a bare `async_hooks` specifier,
  rather than a `node:` built-in.
- Removed the internal review markers from every published JSDoc block.
