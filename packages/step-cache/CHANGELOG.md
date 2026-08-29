# @smthrs/step-cache

## [Unreleased]

### Added

- Split out of `@smthrs/journal`: `CacheStore` now lives here, and the package
  owns the `flows_step_cache` migration. No schema or behavioural change — see
  `docs/specs/Concepts/Journal Split.md`.
