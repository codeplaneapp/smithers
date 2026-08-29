# /testing

## [Unreleased]

### Added

- Added the testing and conformance package scaffold.
- Added scoped Vitest and deterministic layer adapters, core graph and journal
  assertions, typed fixture replay, host conformance, and score gates.
- Added executable identity, interruption, replay, and race conformance pins
  with restartable in-memory reference-engine coverage.
- Added production-only Smithers parity accounting: real owning-package tests
  are linked and missing runtime contracts are explicit gaps.
- Added behavior-level OpenCode source accounting and stable `TASK_TIMEOUT` /
  `RALPH_MAX_REACHED` typed failures.

### Fixed

- Removed the test-owned omnibus capability simulator and false production
  parity claims.
- Replaced hand-written conformance polling loops with bounded Effect
  schedules while retaining live-clock timeout behavior.

## [0.1.0]

### Added

- Initial release.
