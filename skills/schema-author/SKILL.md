---
name: schema-author
description: Design the output schema of a Smithers action as the contract between steps. Use when a step's output feeds a later step, a branch, or a loop condition and must be reliable. Design the schema first, keep it minimal, and prefer typed fields over prose so downstream code can depend on it.
---

# Schema author

This skill covers one thing: the output schema, the `effect/Schema` shape an
action produces and the next step consumes. It is the contract between steps.

For a model-backed action the runtime renders that schema into the run's system
teaching as JSON Schema, decodes the model's final answer with it, spends one
bounded correction re-prompt on a decode miss, and then fails the step with
`StructuredOutputFailure`. For every other action the schema is the encoded form
the engine persists and replays. Either way, a loose or prose-heavy schema makes
every later step unreliable and a tight, typed one makes the graph
deterministic.

The prompt is a schema. Do not ask the model for JSON in prose. Declare the type
and let the runtime enforce it, before you write the prompt or the flow.

## When to reach for it

- A step's output feeds a later step, a branch condition, or a loop's exit test,
  where a wrong shape would silently break the run.
- A model keeps returning the right idea in the wrong shape: free text where you
  need a literal, a missing field the next step indexes into.
- You are about to add a reviewer or a retry to compensate for output you could
  type instead.

Skip it when the output is terminal and nothing downstream reads it. A
`summary` string is fine.

## Design the contract first, keep it minimal

Declare the schema on the action, before the prompt and before the flow body.
Include only what downstream actually reads: a one-line `summary` plus the few
fields the next step indexes into. Every extra field is another thing the model
can get wrong and another correction round.

```ts
import * as AgentAction from "@smthrs/agent/AgentAction"
import { Schema } from "effect"

const Triage = AgentAction.make("review/Triage", {
  payload: { report: Schema.String },
  output: Schema.Struct({
    summary: Schema.String,                                    // terminal, for a person
    severity: Schema.Literals(["low", "medium", "high"]),      // the branch reads this
    category: Schema.Literals(["bug", "feature", "question"]), // routes to a specialist
    needsHuman: Schema.Boolean                                 // gates the approval
  }),
  seat: "anthropic:claude-sonnet-4-5",
  system: ["You triage incoming reports."],
  prompt: ({ report }) => `Triage this report:\n${report}`
})
```

- **Prefer literals and typed fields over prose.** `Schema.Literals([...])`,
  `Schema.Boolean`, and `Schema.Number` give the next step something it can
  switch on. A free-string status is a typo waiting to happen.
- **Make required things required.** An optional field that downstream code
  assumes exists is the classic silent failure. If the fix step always reads
  `analysis.issues`, do not make `issues` optional.
- **Constrain values, not just types.**
  `Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 100 }))` and
  `Schema.Array(Schema.String).check(Schema.isMinLength(1))` turn a decode miss
  into a correction the model can act on, so tighter bounds buy reliability for
  free.
- **Annotate non-obvious fields.** `.annotate({ description: "..." })` rides
  into the rendered JSON Schema and steers the model.

## Wire it: the action's output is the next step's input

The flow body consumes the decoded value directly. There is no output registry
to look a row up in and no guard to write:

```ts
import { Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Schema } from "effect"

const Review = Flow.make("review/Review", {
  payload: { report: Schema.String },
  success: Schema.String,
  body: ({ report }) =>
    Triage.call({ report }).pipe(
      Node.branch({
        if: (triage) => triage.severity === "high",
        then: (triage) => Escalate.call({ triage }),
        else: (triage) => Queue.call({ triage })
      })
    )
})
```

Nothing in that body executes at plan time. `Triage.call` records one node,
`Node.branch` records both arms, and the predicate runs later against the real
decoded value. That is why the schema matters: the branch reads
`triage.severity` as a typed literal, so a plan can be compiled and approved
before a single model call happens.

Keep the prompt body focused on the instruction. The runtime appends the schema;
a hand-written "return JSON like this" block fights the rendered one. See
`skills/prompt-author/SKILL.md`.

## Rich or extensible outputs

When you cannot enumerate every field up front, such as a typed-extraction step
or a payload that carries pass-through metadata, name and type the fields
downstream depends on and let the rest through:

```ts
output: Schema.StructWithRest(
  Schema.Struct({
    title: Schema.String,
    amount: Schema.Number   // downstream arithmetic reads this
  }),
  [Schema.Record(Schema.String, Schema.Unknown)]
)
```

The model may also return a vendor, a date, and line items. They are preserved
rather than rejected.

Use a closed struct when the shape is a true contract a branch keys off. Use an
open one when forward compatibility matters more than locking the shape.

## The schema is a persistence contract

An action's encoded schema is part of its step key, and a step key is what makes
a replay find the recorded result instead of running the effect again. Changing
a field name or a type re-keys the step: the next run re-executes it and the
recorded value is orphaned. Treat a schema change the way you treat a database
migration, and change the action's name when the meaning changes.

## Verify the contract holds

```sh
smithers up review/Review --data '{"report":"..."}' --json
smithers output <run-id> triage   # the persisted decoded row
smithers logs <run-id> --json     # the events, including any correction round
```

See `skills/smithers/SKILL.md` for the runtime and CLI surface, and
`docs/pages/guides/writing-a-flow.md` for the exact decode-and-correct mechanics.
