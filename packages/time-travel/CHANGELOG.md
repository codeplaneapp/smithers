# Changelog

## [Unreleased]

### Changed

- `SqlTimeTravelStore` now requires Effect's `SqlClient` service plus
  `DurableWriter` (the renamed `Database` service).

## [0.1.0] - 2026-08-05

### Added

- Initial durable replay, fork, and time-travel store contracts.

### Fixed

- Made SQL forks executable by cloning restartable engine state and durable attempts.
