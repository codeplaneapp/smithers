# @smthrs/migrate

## [Unreleased]

## [1.0.0-rc.0] - 2026-09-01

### Security

- Derived verification commands are argv values spawned with no shell, so a
  repository file name can no longer be executed as shell syntax; only an
  operator `--verify-*` override keeps shell semantics. The derived formatter
  runs in check mode.
- The grant rules deny every filesystem action (`fs:*`) on 0.x run-state paths
  and their subtrees, so the agent cannot read a database or a log into a
  model call.
- `root`, `--report-dir`, and `--flows-dir` are validated before anything is
  read: normalized, project-relative, non-overlapping, not under a reserved or
  run-state directory, with symlink ancestors resolved, and the report
  directory holding only the tool's own files (`invalid-layout`).
- The prompt fences every source, hint, snippet, and command output with a
  fence the content cannot close, and the contract states that quoted project
  text is data.

### Fixed

- A target that existed before the migration is restored byte for byte when a
  unit fails; the checkpoint records every declared path as present with its
  digest or as absent, verifies backups and restored bytes against those
  digests, and fails closed on any removal or read that is not a typed
  `NotFound`.
- The archive and the deterministic rewrites run before the final
  verification; the final tree is verified, confined, and run-state checked
  again, and the report records that final verification.
- A sealed plan (`MigrateFlow.planSeal`) is recomputed immediately before the
  first checkpoint; a project whose bytes changed since planning is refused
  with `stale-plan`, naming the changed paths.
- Unit artifacts are named injectively (readable id plus an id digest), are
  read back only for the unit they were written for, and a planned unit with no
  recorded outcome is reported `failed`, so an incomplete apply exits 1.
- Postconditions require the files they inspect to exist, cover all six
  dependency fields, and require a root `.gitignore`, which the project unit
  now owns and creates when absent.
- A detected 0.x database is `history-only` even with no rows; `@smthrs/core`
  is an approved package; `Command.isMigrateError` guards on the class and its
  code rather than a `_tag` string; nested internal modules are excluded from
  the export map; `sideEffects` names the executable; the report and
  `--version` carry the package's release version.

### Added

- Added the Smithers 0.x project scanner: construct catalog, semantic mapping,
  package and import detection, read-only run-state detection, construct
  inventory, zod and prompt hints, unit planning, deterministic post-transform
  checks, and the migration report.
