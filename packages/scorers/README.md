# @smthrs/scorers

Flow-native scoring, deterministic sampling, durable observations, and asynchronous score runners. It attaches scorer declarations to target flows without changing their step identity and persists repeated score or inconclusive results.

```sh
npm install @smthrs/scorers
```

## Public API

The root entry point exports these namespaces; top-level modules are also importable from `@smthrs/scorers/<Module>`.

| Module                       | Public exports                                                                                                                                         | Description                                                                         |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| `Binding`                    | `Binding`, `make`                                                                                                                                      | Attaches a scorer, target, optional context and ground truth, and sampling policy.  |
| `Runner`                     | `Job`, `BatchOptions`, `Service`, `Runner`, `make`, `makeNoop`, `layerNoop`, `inconclusive`                                                            | Defines scorer batch execution and constructs inconclusive observations.            |
| `RunnerLive`                 | `Options`, `layer`                                                                                                                                     | Provides non-blocking queue and blocking batch execution over ScoreStore.           |
| `Sampling`                   | `Sampling`, `decide`                                                                                                                                   | Defines and deterministically evaluates score sampling policies.                    |
| `Scorer`                     | `Input`, `Result`, `Scorer`, `MakeOptions`, `make`, `validate`                                                                                         | Declares typed scoring flows and validates results in the inclusive `[0, 1]` range. |
| `ScorerError`                | `ScorerErrorCode`, `ScorerError`                                                                                                                       | Defines typed scoring, storage, and runner failures.                                |
| `ScoreStore`                 | `ObservationBase`, `ScoreObservation`, `InconclusiveObservation`, `Observation`, `Aggregate`, `Service`, `ScoreStore`, `make`, `makeNoop`, `layerNoop` | Defines durable observation append, query, and aggregation.                         |
| `SqlScoreStore`              | `make`, `layer`                                                                                                                                        | Implements ScoreStore over the database service.                                    |
| `Migrations`                 | `run`, `layer`                                                                                                                                         | Applies the score-store schema migrations; available through the root namespace.    |
| `migrations/0001_scores`     | default migration effect                                                                                                                               | Creates the score observation table; available as a direct public subpath.          |
| `migrations/0002_score_jobs` | default migration effect                                                                                                                               | Creates the idempotent score-job table; available as a direct public subpath.       |

```ts
import { Scorer, ScoreStore } from "@smthrs/scorers"
import { Effect } from "effect"

const quality = Scorer.make({
  id: "my-package/scorers/quality",
  version: "1",
  name: "quality",
  score: () => Effect.succeed({ score: 1 })
})

const program = Effect.gen(function*() {
  const store = yield* ScoreStore.ScoreStore
  return { quality, store }
}).pipe(Effect.provide(ScoreStore.layerNoop))
```

Use `SqlScoreStore.layer` for persistence and `RunnerLive.layer()` for live execution. `@smthrs/scorers/package.json` is also exported; `internal/*` and nested `*/index` subpaths are blocked, so the migration aggregator is root-only.
