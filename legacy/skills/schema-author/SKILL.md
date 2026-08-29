---
name: schema-author
description: Design the Zod output schema of a Smithers <Task> as the contract between steps. Use when a step's output feeds a later step (or a branch/loop condition) and must be reliable — design the schema first, keep it minimal, and prefer typed fields over prose so downstream rendering can depend on it.
---

# Schema Author

This skill is about **one thing: the output schema**, the Zod shape a `<Task>`
produces and the next step consumes: Smithers's contract between steps. The
runtime injects a JSON-schema description into the prompt, parses the response,
validates against Zod, retries on mismatch, and persists the row; everything
downstream (`ctx.outputMaybe(...)`, `<Branch>`, `<Loop until={...}>`) reads that
row. A loose or prose-heavy schema makes every later step unreliable; a tight,
typed one makes the graph deterministic.

This is the BAML insight: **the prompt is a schema.** Don't beg the model for
JSON in prose: declare the type and let the runtime enforce it, before you write
the prompt or the workflow.

## When to reach for it

- A step's output feeds a *later* step, a branch condition, or a loop's `until`,
  where a wrong shape would silently break the run.
- An agent keeps returning the right *idea* in the wrong *shape* (free text where
  you need an enum, missing a field downstream code indexes into).
- You're about to add a reviewer/retry to compensate for output you could just
  *type* instead.

Skip it when the output is terminal (nothing downstream reads it): a `summary`
string is fine.

## Design the contract first, keep it minimal

Author the schema in `createSmithers({...})` *before* the prompt or the graph.
Include only what downstream actually reads: a one-line `summary` plus the few
fields the next step indexes into. Every extra field is another thing the agent
can get wrong and another retry.

```tsx
const { Workflow, smithers, outputs } = createSmithers({
  triage: z.object({
    summary: z.string(),                                  // human-readable, terminal
    severity: z.enum(["low", "medium", "high"]),          // a <Branch> reads this
    category: z.enum(["bug", "feature", "question"]),     // routes to a specialist
    needsHuman: z.boolean(),                              // gates an <Approval>
  }),
});
```

- **Prefer enums and typed fields over prose.** `z.enum([...])`, `z.boolean()`,
  `z.number()` give the next step something it can switch on. A free-string status
  is a bug waiting for a typo.
- **Make required things required.** Optional fields downstream assumes exist
  are the classic silent failure: if `fix` always reads `analysis.issues`, don't
  make `issues` optional.
- **Constrain values, not just types.** `z.number().min(0).max(100)`,
  `z.array(...).min(1)`: a validation failure feeds the error back and the agent
  self-corrects on retry, so tighter bounds are free reliability. Annotate
  non-obvious fields with `.describe("...")`; that text rides into the injected
  JSON-schema block and steers the agent.

## Wire it: every `<Task>` gets `output={outputs.x}`

The schema is referenced by the typed `outputs.x` handle, which gives compile-time
checks (a typo in the key is a type error):

```tsx
<Task id="triage" output={outputs.triage} agent={analyst}>
  {`Triage: ${ctx.input.report}`}
</Task>

{/* downstream reads typed fields — no string parsing, no guessing */}
<Branch
  if={ctx.outputMaybe(outputs.triage, { nodeId: "triage" })?.severity === "high"}
  then={<Task id="escalate" .../>}
  else={<Task id="queue" .../>}
/>
```

The prompt body stays clean: end it with the task, let the runtime append the
schema. Don't hand-write a "return JSON like {…}" block: it fights the injected
one (see `skills/prompt-author/SKILL.md`).

When a task simply consumes an upstream output with no branching involved,
prefer `<Task deps={{ triage: outputs.triage }}>` with a `(deps) => ...`
callback: it makes the dependency explicit and needs no `ctx.outputMaybe` guard.
`ctx.outputMaybe`/`<Branch>` stays right when downstream logic depends on the
row's content, as above.

## Rich or extensible outputs: `z.looseObject`

When you can't enumerate every field up front (a typed-extraction step, a payload
that carries pass-through metadata, an evolving spec), use `z.looseObject({...})`:
name and type the fields downstream *depends on*, and let the agent attach extra
keys without tripping validation.

```tsx
extract: z.looseObject({
  title: z.string(),
  amount: z.number(),          // downstream math reads this
  // agent may also return vendor, date, lineItems… — preserved, not rejected
}),
```

Use a strict `z.object` when the shape is a true contract a branch/loop keys off;
use `z.looseObject` when richness and forward-compatibility matter more than
locking the shape.

## Verify the contract holds

Attach a `schemaAdherence` scorer to confirm the shape holds run to run, and read
the persisted row:

```bash
bunx smthrs scores <run-id>          # did adherence hold?
bunx smthrs output <run-id> triage   # see the persisted row
```

See `skills/smithers/SKILL.md` for the runtime/CLI surface and `docs/llms-core.txt`
("The runtime injects a JSON-schema description … validates against Zod") for the
exact validate-and-retry mechanics.
