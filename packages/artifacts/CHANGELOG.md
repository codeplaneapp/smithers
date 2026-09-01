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
- Added workspace-wide writer/sweeper coordination with crash recovery.
- Made download policy immutable and consistent across constructors and layers.
