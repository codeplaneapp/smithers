# @smthrs/scorers

**Documentation:** https://scorers.smithers.sh

Flow-native scoring, deterministic sampling, durable observations, and asynchronous score runners. It attaches scorer declarations to target flows without changing their step identity and persists repeated score or inconclusive results.

The package is workspace-private at `0.1.0`, versioned independently of the published `1.0.0-rc.0` names, and is not published to npm. Its one consumer is `@smthrs/evals`, which supplies the evaluator this package deliberately does not: `evals` filters bindings by target, calls `Sampling.decide` per candidate step, and hands the selected work to a `Runner`.

The contract lives beside the code:

- [`docs/api.md`](./docs/api.md): the public surface, the failure vocabulary, sampling, and the runner rules.
- [`docs/durability.md`](./docs/durability.md): what the store persists, what it refuses, idempotency, paging, and retention.
- [`docs/exports.md`](./docs/exports.md): generated categorized members from source JSDoc.

```ts
import { Runner, RunnerLive, Scorer, ScoreStore } from "@smthrs/scorers"
import { Effect, Layer } from "effect"

const quality = Scorer.make({
  id: "my-package/scorers/quality",
  version: "1",
  name: "quality",
  score: ({ output }) => Effect.succeed({ score: output === "expected" ? 1 : 0 })
})

const program = Effect.gen(function*() {
  const store = yield* ScoreStore.ScoreStore
  return { quality, store }
}).pipe(Effect.provide(ScoreStore.layerNoop))
```

Use `SqlScoreStore.layer` for persistence, `ScoreStore.layerNoop` to run a flow with scoring inert, and `RunnerLive.layer()` for live execution over whichever store is provided.

## Public API

The root entry point exports these namespaces; top-level modules are also importable from `@smthrs/scorers/<Module>`. `@smthrs/scorers/package.json` is exported too; `internal/*`, `migrations/*`, and nested `*/index` subpaths are blocked, so the migration aggregator is root-only.

Every export is listed once, in the reference table in [`docs/api.md`](./docs/api.md), which `test/docs.test.ts` compares against the `@category` JSDoc in `src/`. This table names the modules only, so the two cannot drift apart.

| Module                                  | Description                                                                           |
| --------------------------------------- | ------------------------------------------------------------------------------------- |
| `Binding`                               | Attaches a scorer, target, optional context and ground truth, and sampling policy.    |
| `Runner`                                | Defines scorer batch execution, job identities, and inconclusive observations.        |
| `RunnerLive`                            | Provides the queue and batch runner over a `ScoreStore`.                              |
| `Sampling`                              | Defines and deterministically evaluates score sampling policies.                      |
| `Scorer`                                | Declares typed scoring flows and validates results in the inclusive `[0, 1]` range.   |
| `ScorerError`                           | Defines typed scoring, storage, and runner failures.                                  |
| `ScoreStore`                            | Defines durable observation append, query, and aggregation.                           |
| `SqlScoreStore`                         | Implements `ScoreStore` over the database service.                                    |
| `Migrations`                            | Applies the score-store schema migrations; available through the root namespace.      |
| `migrations/0001_scores`                | Creates the score observation table; applied through `Migrations`, not importable.    |
| `migrations/0002_score_jobs`            | Creates the idempotent score-job table; applied through `Migrations`, not importable. |
| `migrations/0003_score_failure_codes`   | Adds the failure-code column.                                                         |
| `migrations/0004_require_failure_codes` | Backfills and requires a code for every inconclusive row.                             |

## Failures and limits

Every constraint a caller can trip, in one place. The reasoning behind each is in [`docs/api.md`](./docs/api.md) and [`docs/durability.md`](./docs/durability.md).

- **Sampling** is `"all"`, `"none"`, or a `ratio` in the **open** interval `(0, 1)` with a non-empty `seed`. Use `"all"` and `"none"` for the endpoints; `0` and `1` are rejected.
- **A score** must be finite and within `[0, 1]`, in the `Result` schema and in `Scorer.validate` alike.
- **`Scorer.make` throws** a `ScorerError` at plan time for a blank `id` or `version`, or a `config` carrying anything canonical JSON would drop.
- **An observation** is validated and fully encoded before the transaction opens: non-empty keys, a non-negative integer `at`, a non-empty `reason` and structured `code` on an inconclusive observation, a `reason` within `maxReasonBytes`, and `meta` losslessly representable as canonical JSON and within `maxMetadataBytes`. A later mutation of the object cannot change what is stored.
- **A job identity** must be non-empty, within `maxIdentityBytes`, and stable across a restart. Build it with `Runner.jobIdentity`.
- **`observations()`** is paged: `limit` defaults to and may not exceed `maxObservations`, `offset` walks a long history, and `before` is an exclusive upper `at` filter. All three must be safe integers in range or the call fails naming the value.
- **`submit`** does not wait for the scorer to run, but it backpressures once `capacity` queued jobs are outstanding, so it is not safe on a latency-critical path. `capacity` defaults to 1024 and `concurrency` to 1; a value that is not a positive safe integer is coerced to the default rather than rejected.
- **A store failure never fails a batch.** It is logged as a warning, so `runBatch`'s result records what each scorer answered, not what was persisted.
- **`Binding` retains `context` and `groundTruth` by reference.** Scoring runs later, so pass values that do not change.
- **Nothing prunes** `flows_scores` or `flows_score_jobs`.
