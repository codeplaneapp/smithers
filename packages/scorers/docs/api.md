# Public API

`@smthrs/scorers` declares scorers, attaches them to target flows, decides
replay-stable sampling, and persists the resulting observations. It does not
decide what to score or when: `@smthrs/evals` does that and is the only
consumer in the tree.

The root entry point re-exports every module as a namespace. Top-level modules
are also importable directly as `@smthrs/scorers/<Module>`. `internal/*` and
nested `*/index` subpaths are blocked, so the migration aggregator is reachable
only through the root `Migrations` namespace.

| Module                                | Runtime exports                                                                                          | Type-only exports                                                                                               |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `ScorerError`                         | `ScorerErrorCode`, `ScorerError`                                                                         | `ScorerErrorCode`                                                                                               |
| `Scorer`                              | `Input`, `Result`, `make`, `validate`                                                                    | `Input`, `Result`, `Scorer`, `MakeOptions`                                                                      |
| `Binding`                             | `make`                                                                                                   | `Binding`                                                                                                       |
| `Sampling`                            | `Sampling`, `decide`                                                                                     | `Sampling`                                                                                                      |
| `ScoreStore`                          | `Observation`, `validate`, `ScoreStore`, `make`, `makeNoop`, `layerNoop`, and the four documented bounds | `ObservationBase`, `ScoreObservation`, `InconclusiveObservation`, `Observation`, `Aggregate`, `Page`, `Service` |
| `SqlScoreStore`                       | `make`, `layer`                                                                                          | None                                                                                                            |
| `Runner`                              | `Runner`, `make`, `makeNoop`, `layerNoop`, `inconclusive`, `jobIdentity`                                 | `Job`, `BatchOptions`, `Service`                                                                                |
| `RunnerLive`                          | `layer`                                                                                                  | `Options`                                                                                                       |
| `Migrations`                          | `run`, `layer`                                                                                           | None                                                                                                            |
| `migrations/0001_scores`              | default migration effect                                                                                 | None                                                                                                            |
| `migrations/0002_score_jobs`          | default migration effect                                                                                 | None                                                                                                            |
| `migrations/0003_score_failure_codes` | default migration effect                                                                                 | None                                                                                                            |

```typescript
import { Runner, RunnerLive, Scorer, ScoreStore, SqlScoreStore } from "@smthrs/scorers"
import { Effect, Layer } from "effect"

const quality = Scorer.make({
  id: "my-package/scorers/quality",
  version: "1",
  name: "quality",
  score: ({ output }) => Effect.succeed({ score: output === "expected" ? 1 : 0 })
})

const program = Effect.gen(function*() {
  const runner = yield* Runner.Runner
  return yield* runner.runBatch([{
    identity: Runner.jobIdentity(["run-1", "step-7", quality.scorerKey]),
    observation: { targetStepKey: "step-7", scorerKey: quality.scorerKey },
    score: quality.score({ input: "ask", output: "expected" }),
    at: Date.now()
  }])
})

const live = RunnerLive.layer({ concurrency: 4 }).pipe(Layer.provide(SqlScoreStore.layer))
const inert = RunnerLive.layer().pipe(Layer.provide(ScoreStore.layerNoop))
```

## A scorer is a declaration, not a flow body

`Scorer.make` returns a flow value carrying `Input` and `Result` as its declared
schemas, plus `score` and `scorerKey`. `score` is the only implementation:
`MakeOptions` omits `input`, `output`, and `body`, so a scorer cannot declare
two implementations that disagree, and calling the flow itself raises
`FlowError{code: "missing_body"}` as any body-less flow does.

`make` is a plan-time constructor and it throws. Every throw is a `ScorerError`
with code `invalid_declaration`:

- a blank `id` or `version`, named individually;
- a `config` carrying a member canonical JSON would drop (a function, a
  symbol, an `undefined` member, a symbol-keyed property, a cycle, or a
  non-finite number), reported as a path and never as the value;
- a `config` the canonical encoder refuses outright: a `Map`, a `Set`, a class
  instance, a typed array, a `RegExp`;
- a `config` whose own `toJSON` throws.

A member that defines `toJSON` is trusted: its replacement value is hashed
exactly as canonical JSON produces it, and the lossless walk stops there rather
than calling `toJSON` a second time to inspect what it returned.

The dropped-member rule exists because `scorerKey` is
`sha256(canonical({id, version, config}))` and canonical JSON mirrors
`JSON.stringify`. Without it, `{rubric: fn}` and `{}` would be one scorer
forever in the store.

## Sampling

`Sampling` is `"all"`, `"none"`, or `{ratio, seed}` with `ratio` in the **open**
interval `(0, 1)` and a non-empty `seed`. Sample everything with `"all"` and
nothing with `"none"`; `0` and `1` are rejected, so each intent has one
spelling. The bound is in the schema, so an unusable policy cannot be
constructed and carried into a run.

`decide(sampling, targetStepKey, scorerKey)` is deterministic across processes
and replays. The material is length-prefixed and the FNV-1a hash runs over
UTF-8 bytes. Both rules are load-bearing and are frozen by golden vectors in
`test/Sampling.test.ts`: hashing UTF-16 code units collapsed every astral
character in a 1024-code-point block onto one value, and joining components
with `":"` gave `("a:b", "c", "d")` and `("a", "b:c", "d")` one decision.
Changing either moves every sampling decision already taken downstream.

## Failures

`ScorerError.code` is stable and its `cause` is preserved. No failure retains
the whole input; a schema issue names the offending path and a bound names the
offending field.

| Code                  | Raised by                                                                               |
| --------------------- | --------------------------------------------------------------------------------------- |
| `invalid_declaration` | `Scorer.make`, thrown at plan time.                                                     |
| `invalid_score`       | `Scorer.validate`, for a result outside the result contract.                            |
| `invalid_sampling`    | `Sampling.decide`, for a policy outside the vocabulary.                                 |
| `invalid_observation` | `ScoreStore.record` / `recordOnce`, for an observation it refuses to store.             |
| `invalid_request`     | A blank or oversized job identity, or a page limit out of range.                        |
| `inconclusive`        | Carried on an inconclusive observation whose scorer neither scored nor was interrupted. |
| `constraint`          | A database refusal that retrying cannot fix.                                            |
| `store`               | Any other persistence failure, including transient ones.                                |

## Runners

`Runner.Service` has two entry points and one execution path. `submit` queues a
job and returns: it does not wait for the scorer to run, but it backpressures
once `capacity` queued jobs are outstanding, so it is not safe on a
latency-critical path. `runBatch` runs jobs at the configured concurrency and
resolves when all of them have been attempted.

Both are governed by one rule: a scorer failure becomes an inconclusive
observation and never fails the target or the batch. Fiber interruption still
propagates. A score-store failure is logged as a warning and does not fail the
batch either, which means `runBatch`'s result records what each scorer
_answered_, not what was persisted. Reading back through
`ScoreStore.observations` is the only proof of persistence.

`RunnerLive.layer` coerces a `concurrency` or `capacity` that is not a positive
safe integer to its default (1 and 1024) rather than failing, because the
layer's error channel is `never`.

`submit` copies a job's scalar fields as it queues it, so a caller that mutates
the job afterwards cannot change what is recorded. `Binding` does **not** copy
`context` or `groundTruth`; see the note on `Binding` for why.

## Job identity

`recordOnce(identity, observation)` claims `identity` in
`flows_score_jobs` and writes the observation in the same transaction, so a
retried job records once. The identity must be non-empty, at most
`maxIdentityBytes` UTF-8 bytes, and stable across a restart. Build it with
`Runner.jobIdentity([...parts])`, which length-prefixes each component: joining
parts with a delimiter lets two different tuples produce one identity, and a
blank identity used to make every observation after the first vanish silently.
