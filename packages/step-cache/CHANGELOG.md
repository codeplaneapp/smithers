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
  every local and remote boundary. A `result` or `meta` past four MiB, depth
  128, or 100,000 nodes or members now fails with `invalid_cache`.
- Restricted cache keys to a URL-safe grammar and made malformed inputs fail
  before SQL or HTTP I/O. A key outside `[A-Za-z0-9_-]{1,256}` that a previous
  build accepted now fails with `invalid_cache`.
- A `put` reusing a provenance the ledger already holds now resolves `Conflict`
  whenever its `result`, `meta`, or `createdAtMs` differ, where it previously
  resolved `Inserted` and split the head from the recorded evidence.
- `RemoteCacheStore`'s `requestTimeout` is one budget for a whole operation,
  its request and its response body together, rather than one budget per phase.
- Documented that `flows_step_cache_recorded` is append-only with respect to
  this package alone: `@smthrs/engine-store`'s retention deletes ledger rows by
  `recorded_run_id`, and rows a shared-tier write-back landed under a foreign
  run id are never reclaimed.
- `CombinedCacheStore` counts a shared-tier `Conflict` on
  `CacheStoreMetrics.put.Conflict`, so cross-host divergence reaches an
  operator instead of being discarded with the shared outcome.

### Security

- Bounded remote request lifetimes and response bodies, rejected unsafe
  endpoints and headers, and prevented rejected payloads or transport causes
  from entering diagnostics.
