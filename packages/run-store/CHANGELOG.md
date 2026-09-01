# @smthrs/run-store

## [Unreleased]

### Added

- Split out of `@smthrs/journal`: `RunStore`, `AttemptStore`, and `Ownership`
  now live here, and the package owns the `flows_runs` and `flows_attempts`
  migrations. No schema or behavioural change — see
  `docs/pages/concepts/journal.md`.
- `Ownership` re-exports the `OwnerId` schema, which `@smthrs/journal` now
  defines because it is the fence `emitDurable` accepts.
