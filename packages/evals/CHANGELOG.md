# @smthrs/evals

## [Unreleased]

## [1.0.0-rc.0] - 2026-09-01

### Added

- Added fixed suites, deterministic evaluation runs, baselines, regression
  reports, and score gates.
- Added `Runner.makeInline` and `Runner.layerInline`, the in-process batch runner
  a run now scores with by default, so a suite with pure scorers no longer has to
  hand-copy an adapter.
- Added `Suite.limits`, the declared ceilings on concurrency, case count, and
  JSON Lines fixture size.
- Added `Observation.scorerName` and `BaselineRecord.scorerName`, so a report can
  be read without grepping for a scorer digest.
- Added package-owned documentation in `docs/`, gated by `test/docs.test.ts`.

### Changed

- **Breaking:** `Runner.run` requires only `CaseExecutor`. It resolved the
  `Runner` service with `Effect.serviceOption` while declaring it in its
  requirements, which made the in-process scoring path unreachable.
- **Breaking:** `CaseExecutor.Service` is one `run` callback. The twin
  `run`/`execute` pair could diverge, and `make` with neither silently degraded
  to the unavailable executor; it now throws a `TypeError`.
- **Breaking:** `Baseline.Record` is `Baseline.BaselineRecord`, so the global
  `Record` utility type is usable again.
- **Breaking:** `Regression.MissingObservation.stepKey` is required, and
  `Regression.Report`'s `samples` and `inconclusive` are narrowed to the
  observation kinds they actually hold.
- Verify the batch-runner protocol instead of trusting array position. A runner
  that returns the wrong number of observations, or observations identifying
  other jobs, now fails the run with `scorer_protocol` rather than attributing
  one case's score to another.
- Turn a batch score that is not finite and inside `[0, 1]` into an inconclusive
  observation naming the scorer and the offending value.
- Fail `Regression.compare` with `invalid_baseline` when the baseline holds
  records for another suite. Such a comparison used to report zero findings.
- Snapshot and freeze suite cases and bindings, and reject data that cannot be
  structured-cloned, so a run stays reproducible from the validated suite.
- Rebuild every baseline record from its known fields and freeze the array, so
  unknown keys and getters cannot reach a committed artifact.
- Serialize reports and baselines through one bounded, cycle-safe canonical
  encoder. A cyclic case output used to throw a `RangeError` out of a function
  typed `string`.
- Preserve the executor's own code and message on a failed case, and print the
  code in the gate summary, which used to read as a tautology.
- Name every missing, inconclusive, and failed case in `Report.markdown` instead
  of only counting them, and escape, flatten, and cap every rendered cell.
- Encode every tuple key injectively instead of joining on `U+0000`, and reject
  control characters in suite and case names.
- Split the error vocabulary so a caller can branch on it: added
  `invalid_run_options`, `invalid_tolerance`, `scorer_protocol`, and
  `scorer_unavailable`; added `EvalError.path`; removed the unraised
  `missing_ground_truth`.
- Raised coverage thresholds to 100% on branches, functions, lines, and
  statements.
