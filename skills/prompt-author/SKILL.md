---
name: prompt-author
description: Design a single high-quality prompt — the innermost layer an agent reads. Use when a Smithers <Task>'s prompt (its .mdx body or inline string) is vague, ambiguous, or underperforming and you want to tighten the instruction, role, constraints, examples, and output contract before reaching for harness or workflow changes.
---

# Prompt Author

This skill covers **one layer only: the prompt**: the text a single agent reads,
the innermost ring of the layered model (prompt → context → harness → workflow →
backpressure; see `skills/context-engineer/SKILL.md`). When the *graph* is fine
but a step keeps producing weak or off-target output, fix it here, not in the
workflow.

## When to reach for it

- A `<Task>`'s output is vague, wrong-shaped, or inconsistent run to run, or the
  agent ignores a constraint, invents a format, or stops short of the goal.
- You're tempted to add a retry/reviewer to paper over a prompt that never said
  clearly what "done" looks like.

Skip it when the real problem is missing context, wrong tools/permissions, or a
missing review gate: those are outer layers (`context-engineer`, the harness in
`agents.ts`, the workflow graph).

## What makes a strong prompt

1. **One clear instruction**, in plain imperative voice: no instruction soup,
   goal-based beats step-by-step.
2. **Role / framing** when it changes behavior ("You are an independent reviewer
   who can reject the diff"); skip it when it's decoration.
3. **Explicit constraints**: must-nots and bounds, no dead code, no magic
   numbers, don't touch file X, stay under N changes.
4. **Examples** for format- or taste-sensitive work: one good and one bad example
   teaches more than a paragraph of rules.
5. **Decomposition** for multi-part work: a numbered checklist of what to verify
   or produce, so nothing gets silently dropped.
6. **Success criteria / finish line**: "done" as checkable conditions (e.g.
   "existing tests pass; new tests prove per-account limits; reviewer approves"),
   with a cap and fallback for any "keep going until…".

## The Smithers angle: prompts are `.mdx` a `<Task>` renders

Prompts live as `.smithers/prompts/*.mdx` (JSX prompt components), imported into
a workflow as a tag:

```tsx
import ReviewPrompt from "../prompts/review.mdx";
<Task id="review" output={outputs.review} agent={reviewer}>
  <ReviewPrompt diff={ctx.output("implement").patch} />
</Task>
```

The `.mdx` body *is* the prompt; props inject context. Keep it focused on
instruction, constraints, and criteria: let the workflow supply variable context.

**Critical: end the prompt before the output schema, never with your own JSON
spec.** A `<Task>` with an `output={outputs.x}` Zod schema gets a
`**REQUIRED OUTPUT**` block auto-appended to the prompt's *end*; the parser reads
the **last** JSON object in the response, so a hand-written "return JSON like
{…}" fights the injected block and confuses it.

- **Do** describe *what* each field means in prose if it's non-obvious; let the
  schema describe the *shape*.
- **Don't** wrap the agent in conflicting format rules ("write a report" plus a
  JSON schema): the schema wins, so phrase the body so its result *is* the JSON.

Agents with native structured output skip the injected block; a prompt that
defers to the schema works in both modes.

## Tighten-and-verify loop

Edit the `.mdx`, re-run with `--hot true` so wording changes apply on the next
frame without losing finished tasks, then attach a `schemaAdherence` scorer (or a
small `smithers eval` suite) to confirm the new prompt holds the format:

```bash
bunx smithers-orchestrator up workflow.tsx --hot true --input '{"prompt":"…"}'
bunx smithers-orchestrator scores <run-id>     # did schema adherence improve?
```

See `skills/smithers/SKILL.md` for the runtime/CLI surface and `docs/llms-core.txt`
("Good Smithers prompts are goal-based") for the canonical prompt examples.
