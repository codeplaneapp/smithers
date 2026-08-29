# Changelog

## [Unreleased]

### Added

- Added flow slots, envelope-narrowing decoration, retry, cache, approval, and
  bounded composite pattern declarations.
- Added `Bounded`, a width-bounded fan-out that orders members by priority.
- Added `Quarantine`, a join that isolates a failing member from its siblings.
- Added `TryCatchFinally`, an error boundary whose finalizer runs on every
  path.
- Added `Saga`, forward steps whose compensations unwind in reverse on a
  failure or an interruption. `onFailure` defaults to `compensate`, `make`
  refuses a step whose action or compensation is not a flow, and a
  compensation that dies is reported as `compensation_failed`.

### Changed

- `WithRetry` accepts a `backoff` ladder and `nonRetryable` error tags, both
  folded into declaration identity.
- `Panel` gained a runtime form with per-panelist roles and a concurrency
  bound.
- `Escalation` accepts a per-rung `escalateIf`, a `fallback` rung, and returns
  the rung that settled as `{ level, result }`.
- **Breaking:** `Escalation.run` no longer fails with
  `PatternError { code: "exhausted" }` when every rung escalates and no
  `fallback` is declared. It returns the last result as
  `Exhausted<A> { level, result, accepted: false, exhausted: true }`. A caller
  that matched on the `exhausted` code checks `exhausted: true` on the value
  instead.
