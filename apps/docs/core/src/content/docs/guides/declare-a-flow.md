---
title: "Declare a flow"
description: "Build a callable, schema-described flow with Flow.make: the options it accepts, the three kinds of flow you can declare, and the combinators that copy one."
sidebar:
  order: 1
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/core/docs/guides/declare-a-flow.md"
---

A flow is one options object. `Flow.make` returns a callable value: calling it
does not run the body, it constructs a `FlowCall` node that records the call.

```ts
import { Flow, Node } from "@smthrs/core"
import * as Schema from "effect/Schema"

const Review = Flow.make({
  name: "review",
  description: "Reviews one file and reports whether it passes.",
  input: Schema.Struct({ path: Schema.String }),
  output: Schema.Struct({ approved: Schema.Boolean, notes: Schema.String }),
  body: ({ path }) => Node.succeed({ approved: true, notes: `reviewed ${path}` })
})

const call = Review({ path: "src/api.ts" })
```

## The options

| Option         | Default          | What it does                                                                |
| -------------- | ---------------- | --------------------------------------------------------------------------- |
| `name`         | none             | The flow's declared name. A registry resolves it; identity never hashes it. |
| `description`  | none             | Prose a catalog shows.                                                      |
| `input`        | `Schema.Void`    | The input schema. Invariant, because it both decodes and encodes.           |
| `output`       | `Schema.Unknown` | The output schema.                                                          |
| `capabilities` | `[]`             | Capability names this flow needs. Deduplicated and sorted.                  |
| `effects`      | none             | The read and write envelope for everything in the body.                     |
| `model`        | none             | An advisory seat name.                                                      |
| `flows`        | none             | Advisory collaborators: flow values or unresolved registry names.           |
| `prompt`       | none             | An advisory prompt.                                                         |
| `body`         | none             | The function returning the node this flow is.                               |

`Seat` is a name, never a provider model id, and never a credential. Resolving
it into something that can answer is a host's job.

## Three kinds of flow

The combination of `body`, `model`, and `flows` decides what you declared.

**A flow with a body** is the ordinary case. `model`, `flows`, and `prompt` are
still recorded, and they also form the `Body` implementation's declaration, so
two flows sharing one body but declaring different seats are different steps.
The body digest still identifies the code that runs.

**A flow with no body but a `model` or `flows`** is a dynamic flow. The same
three fields form its `Dynamic` implementation identity, and its body defaults
to one dynamic node:

```ts
const Summarize = Flow.agent({
  name: "summarize",
  input: Schema.Struct({ text: Schema.String }),
  output: Schema.String,
  model: "smart",
  prompt: "Summarize the input."
})
```

`Flow.agent` is an alias for `Flow.make`. An agent flow is an ordinary flow
whose omitted body is filled by its model or collaborator declaration; the
alias exists so the declaration reads as what it is.

**A flow with none of the three** is declaration-only. It carries schemas and
metadata for a catalog to show, and calling it or building it raises
`FlowError` with code `missing_body`:

```text
flows/core/FlowError: Cannot call flow "bodyless" without a body
```

That is a useful shape when the implementation lives somewhere else, and a bug
when you meant to write a body. The message names the flow.

## Combinators return a fresh flow

Every combinator copies. The original is never modified, and everything it
carried comes across unchanged, which is what lets a decorator rewrite a flow
tree without dropping the metadata a host reads back.

```ts
import { Annotations, Effects, Placement } from "@smthrs/core"

const Hardened = Review.pipe(
  Flow.withCapabilities(["fs:read"]),
  Flow.within(Placement.sandbox({ image: "node:22" })),
  Flow.annotate(Annotations.Priority, 5),
  Flow.withEffects(Effects.make({
    reads: ["src/**"],
    writes: [],
    mode: "hermetic",
    onConflict: "serialize"
  }))
)
```

| Combinator              | What it changes                                                                       |
| ----------------------- | ------------------------------------------------------------------------------------- |
| `Flow.withCapabilities` | Adds capabilities. The result is sorted and duplicate-free.                           |
| `Flow.within`           | Sets the placement annotation.                                                        |
| `Flow.annotate`         | Sets any typed annotation. `within` is its placement-shaped special case.             |
| `Flow.withFlows`        | Replaces the declared collaborators.                                                  |
| `Flow.withEffects`      | Replaces the effect declaration.                                                      |
| `Flow.sealed`           | Makes the declaration `hermetic` and `sealed`, adding an empty one if there was none. |

`Flow.withFlows` is the one with a branch worth knowing. On a body-backed flow
the body is untouched, so the body digest still identifies the code that runs,
and the new collaborators replace the implementation's declaration, so the
change is visible in key material. On a body-less dynamic flow the
collaborators are the identity, so both the default body and the implementation
are rebuilt.

## Guarding a flow value

`Flow.isFlow` narrows an unknown value to `Flow.Any`, the marker-only
existential type for heterogeneous collections:

```ts
const declared = (values: ReadonlyArray<unknown>): ReadonlyArray<Flow.Any> => values.filter(Flow.isFlow)
```

Use `Flow.Any` for a collection of flows with different schemas, and
`Flow.Input`, `Flow.Output`, and `Flow.Error` to extract one flow's types.

## Where to go next

- [Compose nodes into a plan](/guides/compose-nodes/): what goes inside a body.
- [Annotate a node](/guides/annotate-a-node/): placement, priority, and lanes on
  the node rather than the flow.
- [Declare what a step reads and writes](/guides/declare-reads-and-writes/):
  envelopes and the diagnostics they produce.
