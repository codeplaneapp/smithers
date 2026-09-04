---
title: "@smthrs/scorers"
description: "Flow-native scoring for Smithers: declare a scorer with a durable identity, attach it to a target flow, sample deterministically, and persist every score or failure as an observation."
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/agent/scorers/docs/README.md"
---

`@smthrs/scorers` grades work a flow already did, and keeps the grade.

A scorer is a declaration: an id, a version, an optional configuration, and one
`score` function that turns an execution into a number in `[0, 1]`. The
declaration hashes into a `scorerKey`, the durable identity written on every
observation the scorer produces, so a score recorded a month ago is still
attributable to the exact scorer that produced it. A binding attaches that
scorer to a target flow, a sampling policy decides which target steps get
graded, and the store keeps the results across restarts.

The package deliberately stops there. It does not decide what to score or when
to score it. [`@smthrs/evals`](https://evals.smithers.sh/reference/api/) does that: it filters bindings by
target, calls `Sampling.decide` for each candidate step, and hands the selected
work to a `Runner`. If you want suites, baselines, and CI gates, start with
[the evals documentation](https://evals.smithers.sh/) and come back here for the scorer
contract.

## Who uses this package

Author a scorer here when you need a reusable grader with a stable identity:
an exact-match check, a rubric, a model judge. Compose the store and the runner
here when you host evaluation yourself and need the observations to survive a
restart. Everything else about running an evaluation lives in
[`@smthrs/evals`](https://evals.smithers.sh/reference/api/).

## Install

The package is workspace-private at `0.1.0` and is not published to npm. Inside
this repository, add it as a workspace dependency:

```json
{
  "dependencies": {
    "@smthrs/scorers": "workspace:*"
  }
}
```

For the runtime requirements and the import forms, see
[Installation](/installation/).

## The smallest real example

A scorer, a job identity, and one batch:

```ts
import { Runner, Scorer } from "@smthrs/scorers"
import { Effect } from "effect"

const exactMatch = Scorer.make({
  id: "docs/scorers/exact-match",
  version: "1",
  name: "exact-match",
  score: ({ groundTruth, output }) => Effect.succeed({ score: output === groundTruth ? 1 : 0 })
})

const program = Effect.gen(function*() {
  const runner = yield* Runner.Runner
  return yield* runner.runBatch([{
    identity: Runner.jobIdentity(["run-1", "greet/ada", exactMatch.scorerKey]),
    observation: { targetStepKey: "greet/ada", scorerKey: exactMatch.scorerKey },
    score: exactMatch.score({ input: { name: "Ada" }, output: "Hello, Ada", groundTruth: "Hello, Ada" }),
    at: Date.now()
  }])
})
```

`runBatch` returns one observation per job and never fails: a scorer that
throws produces an inconclusive observation instead of failing the batch or the
target it was grading. For the composition that executes this program against a
real database, see the [Quickstart](/quickstart/).

## The package at a glance

The root entry point exports these namespaces, and each top-level module is
also importable from `@smthrs/scorers/<Module>`:

| Namespace       | What it is                                                                                          |
| --------------- | --------------------------------------------------------------------------------------------------- |
| `Scorer`        | The declaration: input and result schemas, the `score` implementation, and the derived `scorerKey`. |
| `Binding`       | A scorer, a target flow, optional ground truth and context, and a sampling policy.                  |
| `Sampling`      | The replay-stable policy vocabulary and the decision function over it.                              |
| `ScoreStore`    | The durable observation contract: record, record once, page, aggregate.                             |
| `SqlScoreStore` | The SQLite implementation of that contract, migrations included.                                    |
| `Runner`        | Job identities, batch outcomes, and the conversion of a scorer failure into an observation.         |
| `RunnerLive`    | The scoped queue and batch runner over whichever store is provided.                                 |
| `ScorerError`   | The eight stable failure codes and the tagged error that carries them.                              |
| `Migrations`    | The score-store schema migrations, applied by `SqlScoreStore` or on their own.                      |

Every export of every namespace, with signatures and bounds, is on the
[API reference](/reference/api/). The generated member index is in
[Exported members](/exports/).

## Where to go next

- [Installation](/installation/): requirements, dependencies, and import
  forms.
- [Quickstart](/quickstart/): score two executions, persist them, and read
  the aggregate back.
- Guides: [declare a scorer](/guides/declare-a-scorer/),
  [attach one to a flow](/guides/attach-a-scorer-to-a-flow/),
  [run a batch](/guides/run-a-batch-of-scorers/),
  [record a score exactly once](/guides/record-a-score-once/),
  [read scores back](/guides/read-scores-back/), and
  [test with scorers](/guides/test-with-scorers/).
- Concepts: [scorer identity](/concepts/scorer-identity/),
  [replay-stable sampling](/concepts/sampling/), and
  [observations](/concepts/observations/).
- [Durability](/durability/): what the store guarantees across a restart,
  what it refuses to persist, and what it never prunes.
- [Troubleshooting](/troubleshooting/): each failure code, its cause, and
  the fix.
