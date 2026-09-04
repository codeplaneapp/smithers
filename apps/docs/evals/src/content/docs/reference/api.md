---
title: "API reference"
description: "Fixed-suite evaluation, baselines, regression reports, and score gates for flows"
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/agent/evals/docs/api.md"
---

Fixed-suite evaluation, baselines, regression reports, and score gates for
flows.

The package is workspace-private at 1.0.0-rc.0 and is not published to npm. It is
consumed from inside this repository, by `evals/agent`.

## The pipeline

One direction, six modules:

1. `Suite` declares the fixed cases and the scorer bindings that grade them.
2. `Runner` executes every case through an injected `CaseExecutor` and grades the
   executions, producing observations.
3. `Baseline` records what a run scored, as a committed artifact.
4. `Regression` compares the next run with that artifact.
5. `Report` renders the comparison as JSON or Markdown.
6. `Gate` turns the comparison into a verdict and a CI exit code.

```ts
import { Flow } from "@smthrs/core"
import { Baseline, CaseExecutor, Gate, Regression, Runner, Suite } from "@smthrs/evals"
import { Binding, Scorer } from "@smthrs/scorers"
import { Effect, Layer } from "effect"

const greet = Flow.make({ name: "greet" })

const polite = Scorer.make({
  id: "example/polite",
  version: "1",
  name: "polite",
  score: ({ output }) => Effect.succeed({ score: String(output).startsWith("Hello") ? 1 : 0 })
})

const executor = CaseExecutor.make((suiteCase) =>
  Effect.succeed({
    output: `Hello, ${(suiteCase.input as { readonly name: string }).name}`,
    stepKey: suiteCase.name,
    latencyMs: 0,
    target: greet
  })
)

const program = Effect.gen(function*() {
  const suite = yield* Suite.make({
    name: "smoke",
    cases: [{ name: "hello", input: { name: "Ada" } }],
    bindings: [Binding.make({ scorer: polite, appliesTo: greet })],
    concurrency: 1
  })
  const run = yield* Runner.run(suite, { runId: "nightly-2026-01-01", at: "2026-01-01T00:00:00.000Z" })
  const committed = yield* Baseline.load(committedBaselineJson)
  const comparison = yield* Regression.compare(committed, run)
  return Gate.ciGrade(yield* Gate.check(comparison, { mean: 0.9 }))
}).pipe(Effect.provide(Layer.succeed(CaseExecutor.CaseExecutor)(executor)))
```

`Runner.run` needs only `CaseExecutor`. Scoring runs in process by default;
provide `Runner.layerInline` to say so explicitly, `Runner.layerNoop` to state
that a suite must not score, or your own adapter through `options.scorer` or the
`Runner` service.

## How comparison works

Four rules decide what a comparison reports, and none of them are obvious:

- **The step key decides which finding you get.** A score that dropped at a
  _changed_ step key is a `regression`: the target produced different work and it
  graded worse. A score that moved at an _unchanged_ step key is
  `nondeterminism`: the same work graded differently twice. A gate reads both as
  red.
- **`Observation.scorer` is a digest, not a name.** It is the scorer key, derived
  from the scorer's own `{id, version, config}`, and it is what a baseline
  matches on. `Observation.scorerName` carries the readable name beside it, and a
  Markdown report prints `name (first 8 of the key)`.
- **A binding matches its target by reference identity.** `binding.appliesTo` has
  to be the same flow value the execution reports as its `target`; a structurally
  equal copy grades nothing.
- **A baseline belongs to one suite.** New artifacts carry `Baseline.suite`, so
  ownership is checked even when the baseline has no records. Older artifacts
  without that field still load and rely on each record's suite. A suite-less
  artifact with no records also loads, but comparison refuses it because nothing
  establishes ownership. A mismatch fails with `invalid_baseline` rather than
  reporting a clean pass.

## Failure codes

`EvalError.code` is the stable branch point.

| Code                  | Raised when                                                                                                                                | Who fixes it              |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------- |
| `invalid_suite`       | The suite declaration is wrong: a name, a case, a concurrency, a fixture line, non-cloneable case data, or an undecidable sampling policy. | The suite author          |
| `invalid_run_options` | `Runner.run`'s own options are wrong: an empty `runId`, or an `at` that is not a canonical UTC instant.                                    | The caller                |
| `invalid_baseline`    | The committed baseline is unreadable, holds a record the schema rejects, belongs to another suite, or cannot establish suite ownership.    | Regenerate the baseline   |
| `invalid_tolerance`   | A comparison tolerance is not a finite non-negative number.                                                                                | The caller                |
| `executor`            | The target flow failed for a case, or no executor was available.                                                                           | The target or the wiring  |
| `ambiguous_score_job` | Two jobs share a step key and scorer, so an order-only runner cannot attribute their results to cases.                                     | The suite or batch runner |
| `scorer_protocol`     | A batch runner returned the wrong number of observations, or observations identifying jobs other than the ones it was given.               | The batch runner          |
| `scorer_unavailable`  | No batch runner was available to score with.                                                                                               | The wiring                |

Most failures carry a `path` locating the offending value: `cases[1].input`,
`records[3].score`, `options.at`, `runBatch[0]`. A case whose target failed keeps
the executor's own path when it named one and is located at `cases['<name>']`
otherwise, so a failed case is always locatable. Only two failures carry no path:
one about an artifact as a whole (`Baseline` is not JSON, or is not an object)
and one about the absence of a runner (`scorer_unavailable`).

## The batch protocol

`Runner.ScoreBatchRunner.runBatchCorrelated` returns each observation with its
job identity. A correlated runner may return results in any order. A run rejects
a duplicate identity, an unknown identity, a missing identity, the wrong result
count, or an observation that does not echo its job's `targetStepKey` and
`scorerKey` with `scorer_protocol`.

`runBatch` remains the order-only protocol for adapters that cannot return job
identities. Its contract is positional:

1. Exactly one observation per job.
2. In the order the jobs were given.
3. Each observation repeats its job's `targetStepKey` and `scorerKey`.

A run verifies all three and fails with `scorer_protocol` when one is broken.
Before calling an order-only runner, it also refuses two jobs that share a step
key and scorer with `ambiguous_score_job`. Give each case its own step key, or
provide a runner that implements `runBatchCorrelated`. A returned score that is
not finite and inside `[0, 1]` becomes an inconclusive observation naming the
scorer and the offending value; the run's own timestamp, not the adapter's, is
what reaches the observation.

## Determinism and limits

- `Runner.run` takes `runId` and `at` from the caller and stamps every
  observation with them, so two runs over the same inputs produce identical
  observations and identical `Report.json` bytes.
- When the `Suite.make` effect runs, it snapshots its options, copies case and
  binding data with `structuredClone`, and freezes the arrays it returns. The
  suite cannot change after it is validated.
- `Suite.limits` declares the ceilings: `concurrency` 1024, `cases` 10000,
  `fixtureLength` 8388608 code units for one JSON Lines fixture.
- `Report.json` embeds each case's raw `execution.output`. Strings are capped at
  8192 code units and everything JSON cannot express becomes a named marker
  (`[circular]`, `[depth exceeded]`, `[NaN]`, `[function]`), so the serializer is
  total. Nothing is redacted: a suite whose cases carry secrets must not print
  the report where the log is readable.
- `Report.markdown` escapes, flattens, and caps every cell at 240 characters,
  including the heading.

## Public API

The root entry point exports these namespaces; each is also importable from
`@smthrs/evals/<Module>`. `@smthrs/evals/package.json` is exported too;
`internal/*` and nested `*/index` subpaths are not public.

| Export                          | Category      | Summary                                                                             |
| ------------------------------- | ------------- | ----------------------------------------------------------------------------------- |
| `EvalError.EvalErrorCode`       | models        | Stable evaluation failure codes.                                                    |
| `EvalError.EvalError`           | errors        | A typed failure raised while loading or executing an evaluation.                    |
| `Suite.Binding`                 | models        | A scorer binding accepted from `/scorers`.                                          |
| `Suite.Case`                    | models        | One immutable fixed-suite case.                                                     |
| `Suite.MakeOptions`             | models        | Options for constructing a suite.                                                   |
| `Suite.Suite`                   | models        | A validated, named collection of fixed cases and scorer bindings.                   |
| `Suite.limits`                  | models        | The declared ceilings a suite is validated against.                                 |
| `Suite.make`                    | constructors  | Builds and validates a fixed suite.                                                 |
| `Suite.JsonLinesOptions`        | models        | Options used when decoding JSON Lines.                                              |
| `Suite.fromJsonLines`           | constructors  | Loads the `{ name, input, expected? }` JSON Lines fixture format.                   |
| `CaseExecutor.Execution`        | models        | The result of executing one target-flow case.                                       |
| `CaseExecutor.CaseInput`        | models        | Input accepted by a case executor.                                                  |
| `CaseExecutor.Run`              | models        | The one callback a case executor is.                                                |
| `CaseExecutor.Service`          | services      | Runtime shape for an injectable target-flow executor.                               |
| `CaseExecutor.Implementation`   | models        | Implementation accepted by `make`.                                                  |
| `CaseExecutor.CaseExecutor`     | services      | Injectable execution boundary for a target flow.                                    |
| `CaseExecutor.make`             | constructors  | Builds an executor from a callback, or from an object naming it `run` or `execute`. |
| `CaseExecutor.makeNoop`         | constructors  | Builds an executor that fails every case with a typed executor error.               |
| `CaseExecutor.layerNoop`        | layers        | Provides the unavailable executor.                                                  |
| `Runner.Observation`            | models        | One score observation emitted by a suite run.                                       |
| `Runner.ScoreRequest`           | models        | A request sent to the scorers batch runner.                                         |
| `Runner.ScoreJob`               | models        | A blocking scorer job, matching `/scorers/Runner`.                                  |
| `Runner.ScoreBatchRunner`       | services      | Structural adapter for `/scorers`' blocking batch runner.                           |
| `Runner.ScoreObservation`       | models        | A score result aligned with a `ScoreRequest`.                                       |
| `Runner.BatchResult`            | models        | A batch result tagged with the identity of the job that produced it.                |
| `Runner.CaseResult`             | models        | Per-case result retained by the deterministic runner.                               |
| `Runner.RunResult`              | models        | Stable result of a suite run.                                                       |
| `Runner.RunOptions`             | models        | Options for a deterministic suite run.                                              |
| `Runner.Runner`                 | services      | Injectable batch-runner service used when a caller wants a reusable adapter.        |
| `Runner.makeInline`             | constructors  | Builds the in-process batch runner a run scores with by default.                    |
| `Runner.layerInline`            | layers        | Provides the in-process batch runner built by `makeInline`.                         |
| `Runner.run`                    | constructors  | Runs a fixed suite with bounded execution and declaration-order results.            |
| `Runner.layerNoop`              | layers        | Provides a batch runner that is never available.                                    |
| `Baseline.version`              | models        | Current committed baseline artifact version.                                        |
| `Baseline.BaselineRecord`       | models        | One successful score retained by a baseline.                                        |
| `Baseline.Baseline`             | models        | Canonical committed evaluation baseline.                                            |
| `Baseline.fromRun`              | constructors  | Builds and validates a baseline from a run's successful observations.               |
| `Baseline.make`                 | constructors  | Validates an in-memory baseline.                                                    |
| `Baseline.write`                | serialization | Serializes a baseline with recursively sorted keys and stable numbers.              |
| `Baseline.load`                 | serialization | Loads and validates canonical baseline JSON.                                        |
| `Regression.Tolerances`         | models        | Tolerances used for score comparisons.                                              |
| `Regression.Regression`         | models        | A score drop at a changed step key.                                                 |
| `Regression.Nondeterminism`     | models        | A changed score at the same step key, indicating nondeterminism.                    |
| `Regression.MissingObservation` | models        | An observation present on only one side of a comparison.                            |
| `Regression.Report`             | models        | Complete regression comparison.                                                     |
| `Regression.compare`            | constructors  | Compares a run to a baseline, preserving missing and inconclusive observations.     |
| `Report.json`                   | serialization | Serializes a regression report as stable, sorted-key JSON.                          |
| `Report.markdown`               | rendering     | Renders a concise stable Markdown regression report.                                |
| `Gate.Options`                  | models        | Thresholds accepted by a CI score gate.                                             |
| `Gate.check`                    | constructors  | Checks thresholds through `/testing`'s shared ScoreGate arithmetic.                 |
| `Gate.ciGrade`                  | grading       | Maps a gate verdict to the shared CI convention.                                    |

## A worked suite

`evals/agent/` in this repository is a committed suite built on these modules. It
evaluates the Smithers agent itself, offline against a scripted model, and gates
the run on a committed baseline. Run it with `bun evals/agent/run.ts`.
