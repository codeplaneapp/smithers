---
title: "Declare a scorer"
description: "Write a scorer with a stable durable identity: the fields Scorer.make accepts, the result contract it enforces, and the declarations it refuses at plan time."
sidebar:
  order: 1
---

A scorer turns one execution into a number in `[0, 1]`. `Scorer.make` takes the
declaration and returns a flow value carrying the derived `scorerKey` and the
`score` implementation.

## Write the declaration

```ts
import { Scorer } from "@smthrs/scorers"
import { Effect } from "effect"

const contains = Scorer.make({
  id: "docs/scorers/contains",
  version: "1",
  name: "contains",
  description: "One if the output contains the ground-truth phrase.",
  config: { caseSensitive: false },
  score: ({ groundTruth, output }) => {
    const text = String(output).toLowerCase()
    const phrase = String(groundTruth).toLowerCase()
    return Effect.succeed(
      text.includes(phrase)
        ? { score: 1 }
        : { score: 0, reason: `The output does not contain "${phrase}".` }
    )
  }
})
```

Four fields carry meaning:

- **`id`** is the module-owned identity. It is hashed, not resolved, so it can
  be any stable opaque string. A path-like string reads well, but nothing looks
  the path up, and a directory reorganization must not change it.
- **`version`** is the contract version. Bump it whenever the scorer starts
  grading differently, so new numbers land under a new key and old ones stay
  comparable among themselves.
- **`config`** is inert configuration that changes scoring semantics: a rubric,
  a threshold, a judge model id. It participates in the key, so the same scorer
  at two thresholds is two scorer keys.
- **`score`** is the single implementation. It is not hashed, so refactoring it
  leaves stored observations attributable.

`name` and `description` are ordinary flow metadata. `name` is what a report
prints beside the key, so give every scorer one.

## Read the input contract

`score` receives a `Scorer.Input`:

| Field         | Meaning                                                 |
| ------------- | ------------------------------------------------------- |
| `input`       | What the target was given.                              |
| `output`      | What the target produced.                               |
| `groundTruth` | The expected answer, when the caller has one. Optional. |
| `context`     | Anything else the binding attached. Optional.           |
| `latencyMs`   | How long the target took, in milliseconds. Optional.    |

All five are `unknown` except `latencyMs`, because a scorer grades whatever
shape its target produces. Narrow them in the scorer, and put the assumption in
`config` if it affects the grade.

## Return a result the contract accepts

A `Scorer.Result` is `{ score, reason?, meta? }` where `score` is finite and
inside the inclusive `[0, 1]` range. `reason` is the prose a report shows;
`meta` is structured data for later analysis. The range lives in the schema, so
the declared flow output and `Scorer.validate` enforce one contract:

```ts
const validated = Scorer.validate({ score: 0.5 })
```

`validate` fails with `ScorerError` code `invalid_score` for anything outside
the contract, and names the offending score without retaining the whole result:
a scorer result can hold a model response body.

You rarely call `validate` yourself. A [runner](./run-a-batch-of-scorers.md)
validates every result before it records one, which is how an out-of-range
score becomes an inconclusive observation instead of a corrupt row.

## Run it

`score` is the entry point. The flow value itself has no body, so calling it
raises `FlowError` with code `missing_body`:

```ts
const graded = contains.score({ input: "greet Ada", output: "Hello, Ada", groundTruth: "hello" })
```

Hand the resulting `Effect` to a runner as a job's `score` field, or run it
directly when you are testing the scorer in isolation.

## Declarations refused at plan time

`Scorer.make` throws. It is a plan-time constructor, so there is no run to
fail, and every throw is a `ScorerError` with code `invalid_declaration`:

- A non-string or blank `id` or `version`, named individually.
- A `config` carrying a member canonical JSON would drop: a function, a symbol,
  a `bigint`, an explicit `undefined` member, a symbol-keyed property, a cycle,
  or a non-finite number.
- A `config` with a non-enumerable own property, or an array with a non-index
  property.
- A `config` nested more than 1,000 levels.
- A `config` defining `toJSON`, a `Date` included.
- A `config` the canonical encoder refuses outright: a `Map`, a `Set`, a class
  instance, a typed array, or a `RegExp`.

The message reports a path and never the value:

```text
A scorer configuration must be representable as canonical JSON: config.rubric is function
```

Every one of these would otherwise give two different scorers one durable key.
For why refusal is the only decidable answer, see
[Scorer identity](../concepts/scorer-identity.md).

## Next

- [Attach a scorer to a flow](./attach-a-scorer-to-a-flow.md): bind it to a
  target with ground truth and a sampling policy.
- [Run a batch of scorers](./run-a-batch-of-scorers.md): execute scorers and
  persist what they answer.
