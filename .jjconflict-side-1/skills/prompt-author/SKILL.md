---
name: prompt-author
description: Design a single high-quality prompt — the innermost layer an agent reads. Use when a Smithers <Task>'s prompt (its .mdx body or inline string) is vague, ambiguous, or underperforming and you want to tighten the instruction, role, constraints, examples, and output contract before reaching for harness or workflow changes.
---

# Prompt Author

This skill is about **one layer only: the prompt** — the literal text a single
agent reads. It is the innermost ring of the layered model (prompt → context →
harness → workflow → backpressure; see `skills/context-engineer/SKILL.md`). When
the *graph* is fine but a step keeps producing weak or off-target output, the fix
is usually here, not in the workflow.

## When to reach for it

- A `<Task>`'s output is vague, wrong-shaped, or inconsistent run to run.
- The agent ignores a constraint, invents a format, or stops short of the goal.
- You're tempted to add a retry/reviewer to paper over a prompt that simply
  never said clearly what "done" looks like. Fix the prompt first.

Skip it when the real problem is missing context, the wrong tools/permissions, or
a missing review gate — those are outer layers (`context-engineer`, the harness in
`agents.ts`, the workflow graph).

## What makes a strong prompt

1. **One clear instruction.** Lead with the single concrete task in plain
   imperative voice. No instruction soup; goal-based beats step-by-step.
2. **Role / framing** when it changes behavior ("You are an independent reviewer
   who can reject the diff"). Skip it when it's decoration.
3. **Explicit constraints.** State the must-nots and the bounds: no dead code, no
   magic numbers, don't touch file X, stay under N changes.
4. **Examples** for anything format- or taste-sensitive — one good + one bad
   example teaches more than a paragraph of rules.
5. **Decomposition** for multi-part work: a short numbered checklist of what to
   verify or produce, so nothing is silently dropped.
6. **Success criteria / finish line.** Define "done" as checkable conditions
   ("existing tests pass; new tests prove per-account limits; reviewer approves"),
   plus a cap and fallback for any "keep going until…".

## The Smithers angle: prompts are `.mdx` a `<Task>` renders

In a seeded pack, prompts live as `.smithers/prompts/*.mdx`, authored as JSX
prompt components and imported into a workflow as a tag:

```tsx
import ReviewPrompt from "../prompts/review.mdx";
<Task id="review" output={outputs.review} agent={reviewer}>
  <ReviewPrompt diff={ctx.output("implement").patch} />
</Task>
```

The `.mdx` body *is* the prompt; props inject context. Keep the file focused on
instruction + constraints + criteria, and let the workflow supply the variable
context.

**Critical: end the prompt before the output schema, not with your own JSON
spec.** When a `<Task>` has an `output={outputs.x}` Zod schema, the runtime
auto-appends a `**REQUIRED OUTPUT**` block describing the JSON shape to the *end*
of the prompt, and the parser reads the **last** JSON object in the response. So:

- **Do** end your `.mdx`/string with the task and criteria — leave the tail clean
  for the injected schema. Hand-writing your own "return JSON like {…}" fights the
  injected block and confuses the last-JSON parser.
- **Do** describe *what* each field means in prose if it's non-obvious; let the
  schema describe the *shape*.
- **Don't** wrap the agent in conflicting format rules ("write a report" + a JSON
  schema) — the schema wins, so phrase the body so its result *is* the JSON.

Agents that support native structured output skip the injected block, so a prompt
that defers to the schema works in both modes.

## Tighten-and-verify loop

Edit the `.mdx`, re-run with `--hot true` so wording changes apply on the next
frame without losing finished tasks, then attach a `schemaAdherence` scorer (or a
small `smithers eval` suite) to confirm the new prompt actually holds the format:

```bash
bunx smithers-orchestrator up workflow.tsx --hot true --input '{"prompt":"…"}'
bunx smithers-orchestrator scores <run-id>     # did schema adherence improve?
```

See `skills/smithers/SKILL.md` for the runtime/CLI surface and `docs/llms-core.txt`
("Good Smithers prompts are goal-based") for the canonical prompt examples.
