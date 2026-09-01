# @smthrs/step-cache

## [Unreleased]

## [1.0.0-rc.0] - 2026-09-01

### Added

- Extracted the durable step-result cache from `@smthrs/journal`, including
  SQL migrations, metrics, local/remote composition, and a Node test layer.
- Added immutable provenance reads, age-bounded lookups, fenced eviction, and
  explicit inline or deferred remote publication.

### Changed

- Canonicalized stored results and enforced bounded, inert JSON snapshots at
  every local and remote boundary.
- Restricted cache keys to a URL-safe grammar and made malformed inputs fail
  before SQL or HTTP I/O.

### Security

- Bounded remote request lifetimes and response bodies, rejected unsafe
  endpoints and headers, and prevented rejected payloads or transport causes
  from entering diagnostics.
