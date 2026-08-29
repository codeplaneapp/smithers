# @smthrs/artifacts

## [Unreleased]

### Added

- New package. The content-addressed artifact store extracted out of
  `@smthrs/engine-store`'s `StepBoundary`: `ArtifactStore` (contract,
  filesystem, memory, and no-op implementations), `RemoteArtifacts` (the
  dumb-HTTP CAS client), and `CombinedArtifacts` (local-first, remote-second
  read-through with local write-back). See
  `docs/specs/Concepts/Remote Cache.md`.
- Two improvements taken while moving, both from Bazel's `DiskCacheClient`: a
  two-hex-prefix fanout directory layout, and an fsync of the temp file before
  the rename that publishes it. There is no compatibility shim for the old flat
  layout — nothing is released yet.
