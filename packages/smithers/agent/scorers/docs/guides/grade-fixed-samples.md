---
title: "Grade fixed samples"
description: "Apply the shared runtime score-gate contract: sample validation, inclusive thresholds, verdict composition, typed errors, and CI exit codes."
sidebar:
  order: 7
---

`@smthrs/scorers/ScoreGate` owns runtime grading. It imports only Effect and
grades the fixed sample array its caller supplies. It does not read live
observations, run a suite, or require a store or test runner.

`@smthrs/evals/Gate` uses this contract for evaluation reports.
`@smthrs/testing/ScoreGate` re-exports it for test consumers and adds `suite`
and its report-level `ciGrade`. Keep testing in development dependencies.

```ts
import { expectScores, grade, type ScoreSample } from "@smthrs/scorers/ScoreGate"
import * as Effect from "effect/Effect"

const samples: ReadonlyArray<ScoreSample> = [
  { case: "hello", stepKey: "hello-key", scorer: "quality", kind: "score", value: 0.75 }
]
const verdict = await Effect.runPromise(expectScores(samples).mean(0.5))
const result = grade(verdict) // { exitCode: 0, summary: "passed" }
```

The root package also exports the `ScoreGate` namespace.

## Samples and thresholds

`ScoreSample` carries `case`, `stepKey`, and `scorer`. A `kind: "score"`
sample has a finite `value` in `[0, 1]` and an optional `reason`. A
`kind: "inconclusive"` sample has a required `reason`.

`expectScores(samples)` returns a `ScoreExpectation`. Each method returns
`Effect.Effect<Verdict, ScoreGateError>` without environment requirements:

- `mean(threshold)` compares the arithmetic mean of all score observations.
- `min(threshold)` compares the lowest score observation.
- `perCase(thresholds)` compares each named case's lowest observation. Cases
  absent from the threshold record are not gated individually. Each breach
  names the case that missed its threshold.

Thresholds are finite numbers in `[0, 1]`. Equality passes: at a threshold of
`0.5`, `0.49` fails, while `0.5` and `0.51` pass. There is no sample-count
limit; minima use an iterative reduction.

Mean and minimum gates with no scores are `Inconclusive`. A per-case gate is
`Inconclusive` if every named case has no score. An unmeasured case alongside
measured cases contributes an unresolved reason beside the verdict. An empty
per-case threshold record passes after sample validation.

`validateSamples(samples)` returns `Effect.Effect<void, ScoreGateError>` and
rejects every invalid score in input order. All three gates run this validation,
including `perCase({})`. Gates validate thresholds before validating samples.

## Verdicts and composition

```ts
type Verdict =
  | { readonly _tag: "Passed"; readonly inconclusive: ReadonlyArray<string> }
  | { readonly _tag: "Failed"; readonly reasons: ReadonlyArray<string>; readonly inconclusive: ReadonlyArray<string> }
  | { readonly _tag: "Inconclusive"; readonly reasons: ReadonlyArray<string> }
```

A score below a threshold is a `Failed` value in the success channel. A
measurement remains a finding when another observation is unavailable. Faults
travel beside passed or failed measurements in `inconclusive`.

`combine(verdicts, environmentFaults = [])` gives findings precedence over
undecidability. Precedence reads the verdict tags, not the length of their
reason lists, so a `Failed` or `Inconclusive` value with an empty `reasons`
array keeps its tag and its CI exit code. `combine` states a stand-in reason
when such a value leaves it with none. It deduplicates reasons while
preserving first-seen order.
For failures, unresolved reasons order external faults, faults beside decided
gates, then undecidable gates. With no findings, undecidable gate reasons
precede the other faults. An empty verdict array with faults is inconclusive;
`combine([])` is a vacuous pass. Suite adapters must decide whether they have
enough evidence to call it.

`grade(verdict)` returns `{ exitCode: 0 | 1 | 5, summary: string }`:

| Verdict              | Exit | Summary                                                                |
| -------------------- | ---- | ---------------------------------------------------------------------- |
| Clean `Passed`       | 0    | `passed`                                                               |
| `Failed`             | 1    | `failed: <reasons>`, followed by `; unresolved: <faults>` when present |
| `Inconclusive`       | 5    | `inconclusive: <reasons>`                                              |
| `Passed` with faults | 5    | `passed every gate with unresolved: <faults>`                          |

Reason lists are joined with `;`. Threshold breach reasons retain the gate
code, threshold, and actual score, rounded to six significant digits for
display, for example `mean_below_threshold: threshold 0.5, actual 0.49`. A
per-case reason names its case as well,
`case_below_threshold: case 'translation', threshold 0.8, actual 0.2`, so two
cases that miss the same threshold with the same score stay distinct after
`combine` deduplicates equal reasons.

## Errors and compatibility

`ScoreGateError` is a `Schema.TaggedError` with `_tag: "ScoreGateError"`.
Its `code` uses the `ScoreGateCode` schema and matching decoded type:
`invalid_threshold`, `invalid_score`, `mean_below_threshold`,
`min_below_threshold`, or `case_below_threshold`. The latter three remain in
the stable code vocabulary; threshold misses are verdicts, not raised errors.

The error's optional fields preserve the original test contract:

- `threshold` identifies an invalid threshold. No placeholder `actual` is set.
- `actual` identifies the first invalid score. No placeholder threshold is set.
- `samples` lists every invalid score using `InvalidScoreSample`, a schema and
  decoded type with `case`, `stepKey`, `scorer`, and `value`.

`@smthrs/testing/TestingError` re-exports this exact `ScoreGateError` class,
`ScoreGateCode`, and `InvalidScoreSample`. Existing constructors, `instanceof`
checks, tags, field shapes, and schema identities continue to work. There is
no error wrapper and no stored-data migration.
