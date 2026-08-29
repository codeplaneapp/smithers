# @smthrs/evals

Fixed-suite evaluation for flows. It connects target execution and scorer runners to immutable suites, baselines, regression comparison, reports, and CI gates.

```sh
npm install @smthrs/evals
```

## Public API

The root entry point exports these namespaces; each is also importable from `@smthrs/evals/<Module>`.

| Module         | Public exports                                                                                                                                           | Description                                                                      |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `Baseline`     | `version`, `Record`, `Baseline`, `fromRun`, `make`, `write`, `load`, `parse`                                                                             | Creates, serializes, loads, and validates versioned evaluation baselines.        |
| `CaseExecutor` | `Execution`, `CaseInput`, `Service`, `Implementation`, `CaseExecutor`, `make`, `makeNoop`, `layerNoop`                                                   | Defines the injectable boundary that executes one target-flow case.              |
| `EvalError`    | `EvalErrorCode`, `EvalError`                                                                                                                             | Defines typed suite, execution, baseline, and regression failures.               |
| `Gate`         | `Options`, `check`, `ciGrade`                                                                                                                            | Applies score thresholds and maps verdicts to CI exit grades.                    |
| `Regression`   | `Tolerances`, `Regression`, `Nondeterminism`, `MissingObservation`, `Report`, `compare`, `check`                                                         | Compares a run with a baseline and reports regressions and missing observations. |
| `Report`       | `json`, `renderJson`, `markdown`, `renderMarkdown`                                                                                                       | Produces machine-readable and Markdown regression reports.                       |
| `Runner`       | `Observation`, `ScoreRequest`, `ScoreJob`, `ScoreBatchRunner`, `ScoreObservation`, `CaseResult`, `RunResult`, `RunOptions`, `Runner`, `run`, `layerNoop` | Runs suite cases with bounded concurrency and optional scorer batches.           |
| `Suite`        | `Binding`, `Case`, `SuiteCase`, `MakeOptions`, `SuiteOptions`, `Suite`, `make`, `JsonLinesOptions`, `fromJsonLines`                                      | Validates fixed suites and decodes their JSON Lines fixture format.              |

```ts
import { CaseExecutor, Runner, Suite } from "@smthrs/evals"
import { Effect } from "effect"

const program = Effect.gen(function*() {
  const suite = yield* Suite.make({
    name: "smoke",
    cases: [{ name: "hello", input: { name: "Ada" } }],
    concurrency: 1
  })
  return yield* Runner.run(suite, { runId: "nightly-2026-01-01", at: "2026-01-01T00:00:00.000Z" })
}).pipe(Effect.provide(CaseExecutor.layerNoop))
```

`@smthrs/evals/package.json` is also exported. `internal/*` and nested `*/index` subpaths are not public.

## A worked suite

`evals/agent/` in this repository is a committed suite built on these modules. It evaluates the flows agent itself — structured-output decoding, correction re-prompts, cell flow calls, the read-only frame cap, frame budgets, and seat resolution — offline against a scripted model, and gates the run on a committed baseline. Run it with `bun evals/agent/run.ts`.
