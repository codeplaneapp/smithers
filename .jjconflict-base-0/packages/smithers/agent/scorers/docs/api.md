# Public API

`@smthrs/scorers` declares scorers, attaches them to target flows, decides
replay-stable sampling, and persists the resulting observations. It does not
decide what to score or when: `@smthrs/evals` does that and is the only
consumer in the tree.

The root entry point re-exports every module as a namespace. Top-level modules
are also importable directly as `@smthrs/scorers/<Module>`. `internal/*` and
nested `*/index` subpaths are blocked, so the migration aggregator is reachable
only through the root `Migrations` namespace. The four `migrations/*` modules
are blocked as well; each exports its migration effect as the named binding
`migration`, and `Migrations` imports every one of them by name. None has a
default export, because the CommonJS build reads a default import of a sibling
module as the whole interop wrapper rather than the effect.

Every declaration carrying `@category` is listed in the generated
[`exports.md`](./exports.md) index. `//packages/smithers/agent/scorers:docsPages` drift-checks
that projection, while `test/docs.test.ts` also keeps the curated contract table
at the end of this page synchronized by public export name.

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

- a non-string or blank `id` or `version`, named individually;
- a `config` carrying a member canonical JSON would drop (a function, a
  symbol, an `undefined` member, a symbol-keyed property, a cycle, or a
  non-finite number), or a non-enumerable own property, reported as a path and
  never as the value;
- a `config` nested more than 1,000 levels, reported at the bounded path;
- a `config` defining `toJSON`, including a `Date`, reported at its path;
- a `config` the canonical encoder refuses outright: a `Map`, a `Set`, a class
  instance, a typed array, or a `RegExp`.

Canonical JSON hashes the value returned by `toJSON`, so anything that
replacement loses is absent from the durable identity. Refusal is the only
decidable answer: inspecting the replacement would execute caller code a
second time with no promise that both calls agree.

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
| `invalid_request`     | A blank or oversized job identity, or a page bound out of range.                        |
| `inconclusive`        | Carried on an inconclusive observation whose scorer neither scored nor was interrupted. |
| `constraint`          | A database refusal that retrying cannot fix.                                            |
| `store`               | Any other persistence failure, including transient ones.                                |

## Runners

`Runner.Service` has three entry points and one execution path. `submit` queues
a job and returns: it does not wait for the scorer to run, but it backpressures
once `capacity` queued jobs are outstanding, so it is not safe on a
latency-critical path. `runBatchCorrelated` runs jobs at the configured
concurrency and returns an `Outcome` for each one. Each outcome carries the job
identity and reports `persisted`, `duplicate`, or `failed` for the durable
write. `runBatch` is derived from it and returns only the observations in job
order to preserve the existing contract.

Both are governed by one rule: a scorer failure becomes an inconclusive
observation and never fails the target or the batch. Fiber interruption still
propagates. A score-store failure is logged as a warning and does not fail the
batch either. `runBatch` records what each scorer _answered_, while
`runBatchCorrelated` also records what the store did. A `duplicate` outcome
means the identity was already claimed; it does not claim that the returned
observation is the one already in the store.

`RunnerLive.layer` coerces a `concurrency` or `capacity` that is not a positive
safe integer to its default (1 and 1024) rather than failing, because the
layer's error channel is `never`.

## Snapshotting

Three handoffs decide what a later mutation can still change, and each one has
one answer.

`submit` copies a job's scalar fields as it queues it, and `record` and
`recordOnce` copy and fully encode an observation when they are _called_, not
when the Effect they return is run. Both entry points used to read the caller's
object at run time, so building `record(observation)`, mutating the object, and
then running the Effect persisted the mutated value.

`Binding` does **not** copy `context` or `groundTruth`. It is the one deliberate
exception: a ground truth is frequently a value with no JSON representation, and
refusing those at binding time would be the larger break. The reasoning is on
the `Binding` interface's own JSDoc. Pass values that do not change, or copy
before binding.

## Job identity

`recordOnce(identity, observation)` claims `identity` in
`flows_score_jobs` and writes the observation in the same transaction, so a
retried job records once. The identity must be non-empty, at most
`maxIdentityBytes` UTF-8 bytes, and stable across a restart. Build it with
`Runner.jobIdentity([...parts])`, which length-prefixes each component: joining
parts with a delimiter lets two different tuples produce one identity, and a
blank identity used to make every observation after the first vanish silently.
The claim must report exactly zero or one affected row. Zero is a duplicate;
one proceeds to the observation insert; any other driver result fails and rolls
the transaction back.

## Reference

Every export carrying a `@category` tag, once. `test/docs.test.ts` fails when
this table and `src/` disagree.

| Export                               | Category     | Summary                                                                         |
| ------------------------------------ | ------------ | ------------------------------------------------------------------------------- |
| `ScorerError.ScorerErrorCode`        | models       | The eight stable failure codes, as a schema and a type.                         |
| `ScorerError.ScorerError`            | errors       | A typed declaration, execution, or persistence failure.                         |
| `Scorer.Input`                       | schemas      | Input supplied to a scorer flow.                                                |
| `Scorer.Result`                      | schemas      | Successful scorer output, carrying the inclusive `[0, 1]` score bound.          |
| `Scorer.Scorer`                      | models       | A declaration-only flow with an independent durable identity.                   |
| `Scorer.MakeOptions`                 | models       | Options for `Scorer.make`, minus `input`, `output`, and `body`.                 |
| `Scorer.make`                        | constructors | Declares a scorer and derives its `scorerKey`. Throws at plan time.             |
| `Scorer.validate`                    | validation   | Decodes a scorer result against `Result`.                                       |
| `Binding.Binding`                    | models       | A scorer, ground truth, context, and sampling policy attached to a target flow. |
| `Binding.make`                       | constructors | Creates a binding, defaulting to sampling every target step.                    |
| `Sampling.Sampling`                  | schemas      | `"all"`, `"none"`, or a `{ratio, seed}` policy over the open interval `(0, 1)`. |
| `Sampling.decide`                    | predicates   | Decides a sample from stable target, scorer, and seed material.                 |
| `ScoreStore.maxReasonBytes`          | models       | Maximum stored size of an observation `reason`, in UTF-8 bytes.                 |
| `ScoreStore.maxMetadataBytes`        | models       | Maximum encoded size of an observation `meta`, in UTF-8 bytes.                  |
| `ScoreStore.maxIdentityBytes`        | models       | Maximum size of a `recordOnce` job identity, in UTF-8 bytes.                    |
| `ScoreStore.maxObservations`         | models       | Largest page `observations` returns, and its default.                           |
| `ScoreStore.ObservationBase`         | models       | Fields shared by successful and inconclusive observations.                      |
| `ScoreStore.ScoreObservation`        | models       | A successful score retained by the store.                                       |
| `ScoreStore.InconclusiveObservation` | models       | A scorer failure retained without failing its target.                           |
| `ScoreStore.Observation`             | schemas      | The durable observation contract, as a runtime schema and a type.               |
| `ScoreStore.Aggregate`               | models       | Count, mean, and minimum over successful scores, plus the inconclusive count.   |
| `ScoreStore.Page`                    | models       | Page bounds for `observations`: `limit`, `offset`, and the `before` filter.     |
| `ScoreStore.Service`                 | services     | The durable score store implementation.                                         |
| `ScoreStore.ScoreStore`              | services     | Context service for durable scorer observations.                                |
| `ScoreStore.make`                    | constructors | Constructs a score store.                                                       |
| `ScoreStore.makeNoop`                | constructors | Constructs an inoperative score store.                                          |
| `ScoreStore.layerNoop`               | layers       | Provides the inoperative score store.                                           |
| `ScoreStore.validate`                | validation   | Decodes an observation against `Observation` before it is persisted.            |
| `SqlScoreStore.make`                 | constructors | Builds the SQL-backed store and applies its migrations.                         |
| `SqlScoreStore.layer`                | layers       | Provides the SQL-backed score store.                                            |
| `Runner.Job`                         | models       | One scorer execution request and its durable idempotency key.                   |
| `Runner.BatchOptions`                | models       | Batch execution options.                                                        |
| `Runner.Recorded`                    | models       | Whether a batch observation was persisted, duplicated, or failed.               |
| `Runner.Outcome`                     | models       | A batch observation tagged with its job identity and durable write result.      |
| `Runner.Service`                     | services     | The runtime scorer runner implementation.                                       |
| `Runner.Runner`                      | services     | Context service for live and batch scorer execution.                            |
| `Runner.make`                        | constructors | Constructs a scorer runner.                                                     |
| `Runner.makeNoop`                    | constructors | Constructs an inoperative scorer runner.                                        |
| `Runner.layerNoop`                   | layers       | Provides the inoperative scorer runner.                                         |
| `Runner.jobIdentity`                 | constructors | Builds a length-prefixed `Job.identity` from its components.                    |
| `Runner.inconclusive`                | converting   | Converts a scorer failure into a typed inconclusive observation.                |
| `RunnerLive.Options`                 | models       | Live runner worker configuration.                                               |
| `RunnerLive.layer`                   | layers       | Provides the scoped queue and the blocking batch runner.                        |
| `Migrations.run`                     | migrations   | Applies all score-store migrations.                                             |
| `Migrations.layer`                   | layers       | Applies score-store migrations when the layer is constructed.                   |
