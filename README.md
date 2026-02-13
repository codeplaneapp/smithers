# Smithers

**Deterministic, durable AI workflows defined as React components.**

## What Smithers Does

* Defines workflows as React component trees
* Executes tasks in sequence, parallel, or loops
* Persists every task result to SQLite
* Validates outputs against Zod schemas
* Re-renders the workflow after each step
* Resumes exactly where it left off after crashes
* Supports subscriptions

There is no hidden in-memory state. Every task result is stored as:

```
(runId, nodeId, iteration) → validated output row
```

---

## Example

```tsx
import { createSmithers, Task, Sequence } from "smithers-orchestrator";
import { z } from "zod";

const analyzeSchema = z.object({
  summary: z.string(),
  severity: z.enum(["low", "medium", "high"]),
});

const fixSchema = z.object({
  patch: z.string(),
  explanation: z.string(),
});

const { Workflow, smithers } = createSmithers({
  analyze: analyzeSchema,
  fix: fixSchema,
});

export default smithers((ctx) => (
  <Workflow name="bugfix">
    <Sequence>
      <Task id="analyze" output="analyze" agent={analyzer}>
        {`Analyze the bug: ${ctx.input.description}`}
      </Task>

      <Task id="fix" output="fix" agent={fixer}>
        {`Fix this issue: ${ctx.output("analyze", { nodeId: "analyze" }).summary}`}
      </Task>
    </Sequence>
  </Workflow>
));
```

This defines a two-stage DAG:

```
analyze → fix
```

After `analyze` completes:

* Output is validated against `analyzeSchema`
* Written to SQLite
* The tree re-renders
* `fix` becomes runnable

If the process crashes, Smithers resumes from the last completed node.

---

## Install

Requires Bun ≥ 1.3.

```bash
bun add smithers-orchestrator ai @ai-sdk/anthropic zod@^4
```

> **Note:** Smithers requires Zod v4. Zod v3 is not compatible.

---

## Mental Model

### 1. React Tree = Execution Plan

Your JSX tree is not UI. It is a declarative execution graph.

* `<Workflow>` is the root.
* `<Task>` is a node.
* `<Sequence>` runs children in order.
* `<Parallel>` runs children concurrently.
* `<Ralph>` repeats children until a condition is met.

After each task finishes, Smithers re-renders the tree with updated context.

If new nodes are unblocked, they become runnable.

---

### 2. Zod Schemas = Durable Tables

Each output schema becomes a SQLite table.

```ts
const analyzeSchema = z.object({
  summary: z.string(),
  severity: z.enum(["low", "medium", "high"]),
});
```

* Agent output must validate.
* If validation fails, the task retries (with error feedback).
* Validated output is persisted.

This makes workflows typed, inspectable, and reproducible.

---

### 3. Deterministic Execution

Execution order is:

* Depth-first
* Left-to-right
* Unblocked nodes only

There is no hidden scheduler logic in user code.

---

## Core Components

| Component    | Purpose                        |
| ------------ | ------------------------------ |
| `<Workflow>` | Root container                 |
| `<Task>`     | AI or static task node         |
| `<Sequence>` | Ordered execution              |
| `<Parallel>` | Concurrent execution           |
| `<Branch>`   | Conditional execution          |
| `<Ralph>`    | Loop until condition satisfied |

---

## Validation and Retries

If an agent returns malformed JSON:

1. Smithers appends the validation error to the prompt
2. Retries the task
3. Persists only valid output

```tsx
<Task
  id="analyze"
  output="analyze"
  outputSchema={analyzeSchema}
  agent={analyzer}
  retries={2}
>
  Analyze the codebase
</Task>
```

---

## Looping with `<Ralph>`

`<Ralph>` repeats its children until a condition becomes true.

Each iteration is stored separately in the database.

```tsx
<Ralph
  until={ctx.latest("review", "validate")?.approved}
  maxIterations={5}
>
  <Task id="implement" output="implement" agent={coder}>
    Fix based on feedback
  </Task>

  <Task id="validate" output="review" agent={reviewer}>
    Review the implementation
  </Task>
</Ralph>
```

---

## Dynamic Branching

Because the workflow re-renders after each task, you can branch with normal JSX:

```tsx
<Task id="assess" output="assess" agent={analyst}>
  Assess complexity
</Task>

{ctx.output("assess", { nodeId: "assess" }).complexity === "high" ? (
  <Task id="plan" output="plan" agent={architect}>
    Plan implementation
  </Task>
) : (
  <Task id="implement" output="code" agent={coder}>
    Quick fix
  </Task>
)}
```

---

## CLI

```bash
smithers run workflow.tsx --input '{"description": "Fix bug"}'
smithers resume workflow.tsx --run-id abc123
smithers list workflow.tsx
smithers approve workflow.tsx --run-id abc123 --node-id review
```

---

## Built-in Tools

```tsx
import { read, edit, bash, grep, write } from "smithers-orchestrator/tools";
```

* Sandboxed to workflow root
* `bash` is network-disabled by default

---

## How Execution Works

1. Render React tree
2. Identify runnable tasks
3. Execute task
4. Validate output
5. Persist to SQLite
6. Re-render
7. Repeat

Crash at any point → resume from last persisted step.

---

## When to Use Smithers

* Multi-step AI workflows
* Tool-using agents
* Systems requiring resumability
* Human-in-the-loop review cycles
* Typed, inspectable AI pipelines

Not intended for:

* Single prompt calls
* Stateless toy scripts

---

## License

MIT
