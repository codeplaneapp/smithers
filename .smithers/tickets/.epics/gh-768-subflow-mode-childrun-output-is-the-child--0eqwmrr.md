# <Subflow mode="childRun"> output is the child's LAST TASK ROW, not a table-keyed snapshot — undocumented, and the validation error says neither expected nor received

GitHub: https://github.com/smithersai/smithers/issues/768

## Summary

`<Subflow mode="childRun">` stores the child workflow's **last task row** as its output, but nothing in the docs or types says so. The natural assumption — that a child run's output is a snapshot keyed by the child's output-table names — produces a schema that fails validation on **every** child, with an error that names neither the expected nor the received shape.

## What happens

Given a child workflow with output tables `childImplement` / `childReview` / `childBranch`, this parent schema looks obviously right:

```ts
const childRunSchema = z.object({
  childImplement: z.array(z.record(z.string(), z.unknown())).default([]),
  childReview:    z.array(z.record(z.string(), z.unknown())).default([]),
  childBranch:    z.array(z.record(z.string(), z.unknown())).default([]),
});

<Subflow mode="childRun" workflow={child} input={spec} output={outputs.childRun} />
```

Every child then fails with:

```
bridge-managed compute task execution failed ... nodeId=child-... workflowName=<child>
error="Task output failed validation for childRun See https://smithers.sh/reference/errors"
```

In a real run this was 8/8 children failed, 0 succeeded — even though each child had done its work correctly (the worktree branches carried real, reviewed commits). The failure is purely the parent's output schema.

## Root cause

`packages/engine/src/child-workflow.js`:

```js
function normalizeChildOutput(runResult) {
  const output = runResult.output;
  if (!Array.isArray(output)) return stripSystemColumns(output);
  const rows = output.map((row) => stripSystemColumns(row));
  if (rows.length === 0) return null;
  if (rows.length === 1) return rows[0];
  return rows;
}
// ...
return { ..., output: normalizeChildOutput(result) };   // line ~144
```

So the stored value is `runResult.output`, i.e. the child's run result, which is **the last task's row** (per the documented "a run's reported output is whatever the LAST task produced"). Not a per-table snapshot. Correct schema:

```ts
// The child's LAST task is `commit`, so the row is that task's schema.
const childRunSchema = z.object({
  issueNumber: z.number(),
  branch: z.string().default(""),
  committed: z.boolean().default(false),
  notes: z.string().default(""),
});
```

## Two things that make this much worse

1. **The error message doesn't say what was expected vs received.** `Task output failed validation for childRun` gives no diff, no received shape, no zod issue list. Debugging required reading the engine source. Including the zod error (path + expected/received) would make this a 30-second fix.
2. **`retries={0}` on a Subflow means `maxAttempts=1`, so the failure is permanent** — and since a schema mismatch is deterministic, every child dies on first attempt with no signal that the problem is the *parent's* schema rather than the child's work.

## Requests

1. **Document the childRun output contract** on the Subflow page and in `SubflowProps.ts`'s `output` jsdoc: "the child's result — its last task's row — not a table-keyed snapshot." Note the corollary that adding a new last task to the child silently changes the parent's expected output shape.
2. **Make the validation error actionable**: include the zod issues and the received value's top-level keys.
3. Consider a typed helper or an example in `examples/` showing a childRun Subflow whose child has multiple output tables, so the "which row do I get?" question is answered by a runnable reference.

Related: #767 (detached child runs orphan on parent cancel). Both were hit building an orchestrator-of-orchestrators workflow.

