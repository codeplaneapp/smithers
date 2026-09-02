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
