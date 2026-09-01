# @smthrs/artifacts

## [Unreleased]

## [1.0.0-rc.0] - 2026-08-31

### Added

- New package. The content-addressed artifact store extracted out of
  `@smthrs/engine-store`'s `StepBoundary`: `ArtifactStore` (contract,
  filesystem, memory, and no-op implementations), `RemoteArtifacts` (the
  dumb-HTTP CAS client), and `CombinedArtifacts` (local-first, remote-second
  read-through with local write-back).
- Two improvements taken while moving, both from Bazel's `DiskCacheClient`: a
  two-hex-prefix fanout directory layout, and an fsync of the temp file before
  the rename that publishes it. There is no compatibility shim for the old flat
  layout.

### Changed

- Snapshotted all caller-owned byte arrays at Effect start and copied every
  read result.
- Added strict SHA-256 address validation, typed configuration and crypto
  failures, finite remote deadlines and body limits, and deterministic
  `findMissing` deduplication.
- Added workspace-wide writer/sweeper coordination with crash recovery, and
  reclaimed crash-orphaned lock files in the same conservative scratch sweep
  that reclaims `.tmp-*` payloads.
- Made download policy immutable and consistent across constructors and layers.
- Made `CombinedArtifacts.get`'s local write-back opportunistic: a local tier
  that cannot store bytes the shared tier already served costs the next read a
  round trip instead of failing this one. `minimal` now repairs a corrupt local
  address, because an address the local tier already claims must be one it can
  serve.
- Applied caller-configured headers before the protocol's own, so a configured
  `content-range`, `content-type`, or `content-length` can no longer overwrite
  a chunked upload's computed headers.
- Reported a refused byte snapshot as `unavailable`, the host-refusal code,
  rather than as a crypto `digest_failed`.
- Ignored a resume prefix past the safe integer range instead of trusting a
  rounded offset.
- Gave `ArtifactSweep` its own `SweepOptions` rather than the store's options,
  which carried a `durability` field it ignored, and exported
  `ArtifactStore.defaultDirectory` so the store and its sweep name one
  directory.
- Classified a backup-lease marker another process already reaped as a clean
  release rather than logging a release failure.
