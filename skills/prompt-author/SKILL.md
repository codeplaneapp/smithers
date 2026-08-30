---
name: prompt-author
description: Design a single high-quality prompt, the innermost layer an agent reads. Use when a Smithers action's prompt, whether a Markdown flow body or the string an AgentAction builds, is vague, ambiguous, or underperforming, and you want to tighten the instruction, role, constraints, examples, and output contract before changing the flow.
---

# Prompt author

This skill covers one layer: the prompt, the text a single model reads. When the
flow graph is right but one step keeps producing weak or off-target output, fix
it here, not in the graph.

## When to reach for it

- An action's output is vague, wrong-shaped, or inconsistent run to run; the
  model ignores a constraint, invents a format, or stops short of the goal.
- You are tempted to add a retry or a reviewer to paper over a prompt that never
  said what "done" looks like.

Skip it when the real problem is missing context, a missing capability, or a
missing gate. Those are outer layers: the payload the action is called with, the
capability envelope the host grants, and the flow graph itself.

## What makes a strong prompt

1. **One clear instruction**, in plain imperative voice. Goal-based beats
   step-by-step.
2. **Role or framing** when it changes behavior ("You are an independent
   reviewer who can reject the change"). Skip it when it is decoration.
3. **Explicit constraints.** Must-nots and bounds: no dead code, no magic
   numbers, do not touch this file, stay under this many changes.
4. **Examples** for format-sensitive or taste-sensitive work. One good and one
   bad example teaches more than a paragraph of rules.
5. **Decomposition** for multi-part work: a numbered checklist of what to verify
   or produce, so nothing is silently dropped.
6. **Success criteria.** State "done" as checkable conditions, and give any
   "keep going until" a cap and a fallback.

## Where a prompt lives in Smithers 1.0

There are two homes, and they are not interchangeable.

**A prompt built by a model-backed action.** `AgentAction.make` takes `system`,
the stable teaching that stays in the system prefix across every frame, and
`prompt`, a pure function from the step payload to the message text:

```ts
import * as AgentAction from "@smthrs/agent/AgentAction"
import { Schema } from "effect"

const Review = AgentAction.make("review/Review", {
  payload: { diff: Schema.String },
  output: Schema.Struct({
    approved: Schema.Boolean,
    issues: Schema.Array(Schema.String)
  }),
  seat: "anthropic:claude-sonnet-4-5",
  system: [
    "You are an independent reviewer. You may reject a change.",
    "Report only defects you can point at in the diff."
  ],
  prompt: ({ diff }) => `Review this diff:\n${diff}`
})
```

Put the durable teaching in `system` and the per-call material in `prompt`. The
split is not cosmetic: the system prefix is stable across frames of one call, so
the model rereads the teaching every frame while the payload text appears once.

**A Markdown flow.** A flow can be a Markdown file with frontmatter, discovered
at `flows/<name>/flow.mdx`. The body is the prompt, the frontmatter is the
contract, and the only input is a single `args` string:

```mdx
---
name: review
description: Reviews a change for correctness, regressions, and maintainability.
capabilities: ["fs:read:**"]
---

Review the supplied change and report concrete, actionable findings.
```

Markdown flows are for prompts a person edits without touching TypeScript. Reach
for one when the flow is a prompt; reach for `AgentAction` when the prompt needs
typed payload fields or a typed output.

## End the prompt before the output schema

An action with an `output` schema has that schema rendered into the run's system
teaching as JSON Schema. The runtime decodes the final answer with it, spends
one bounded correction re-prompt on a miss, then fails the step
`StructuredOutputFailure`.

- **Do** describe in prose what a field means when it is not obvious. Let the
  schema describe the shape.
- **Do not** hand-write a "return JSON like this" block. It competes with the
  rendered schema, and the decoder reads the whole answer first and then the
  last balanced JSON container inside it, so a second specimen block is exactly
  the thing that makes decoding ambiguous.
- **Do not** ask for two output formats at once. If the body says "write a
  report" and the schema says `{ approved, issues }`, the schema wins. Phrase the
  instruction so its result is the structured value.

See `skills/schema-author/SKILL.md` for designing that schema.

## Tighten and verify

Change the text, re-run, and read what actually came back:

```sh
smithers up review/Review --data '{"diff":"..."}' --json
smithers output <run-id> review    # the decoded value
smithers logs <run-id> --json      # every frame, including correction rounds
```

Editing a prompt is not free of consequence for replay. A deferred function is
digested by its source text, so changing the prompt changes that node's identity
and re-keys the step. The next run re-executes it instead of replaying the
recorded answer, which is exactly what you want while tuning and worth knowing
before you reformat a prompt you did not mean to re-run.

See `skills/smithers/SKILL.md` for the runtime and CLI surface, and
`docs/guides/writing-a-flow.md` for the model-call declaration in full.
