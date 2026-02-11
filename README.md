# Smithers

**Declarative AI workflow orchestration with React.**

Multi-agent workflows are messy. Prompt chains break. Error handling is ad hoc. State lives in variables that vanish when your process crashes. Smithers fixes this by letting you define AI workflows as React component trees — declarative, composable, and automatically durable.

```tsx
import { createSmithers, Task, Parallel, Ralph } from "smithers-orchestrator";

const { Workflow, smithers } = createSmithers({
  discover: z.object({ issues: z.array(z.string()) }),
  ticket:   z.object({ title: z.string(), body: z.string() }),
  review:   z.object({ approved: z.boolean(), feedback: z.string() }),
});

export default smithers((ctx) => (
  <Workflow name="triage">
    <Task id="discover" output="discover" agent={analyst}>
      Find issues in the codebase
    </Task>
    <Parallel>
      {ctx.output("discover", { nodeId: "discover" }).issues.map((issue, i) => (
        <Task key={i} id={`ticket-${i}`} output="ticket" agent={writer}>
          {`Write a ticket for: ${issue}`}
        </Task>
      ))}
    </Parallel>
    <Ralph until={ctx.latest("review", "review-0")?.approved} maxIterations={3}>
      <Task id="review-0" output="review" agent={reviewer}>
        {`Review the tickets. Previous feedback: ${ctx.latest("review", "review-0")?.feedback ?? "none"}`}
      </Task>
    </Ralph>
  </Workflow>
));
```

Your workflow is a DAG. Each `<Task>` is a node. `<Sequence>`, `<Parallel>`, `<Branch>`, and `<Ralph>` control execution order. The tree re-renders after each task completes — just like React re-renders after state changes. Outputs are persisted to SQLite, so a crashed workflow resumes exactly where it left off.

## Install

Requires [Bun](https://bun.sh) >= 1.3.

```bash
bun add smithers-orchestrator ai @ai-sdk/anthropic zod
```

## Quick Start

### 1. Define your schemas

Each task output is a Zod schema. Smithers auto-creates SQLite tables from them.

```ts
import { z } from "zod";

const analyzeSchema = z.object({
  summary: z.string(),
  severity: z.enum(["low", "medium", "high"]),
  files: z.array(z.string()),
});

const fixSchema = z.object({
  patch: z.string(),
  explanation: z.string(),
});
```

### 2. Create your smithers instance

```ts
import { createSmithers, Task, Sequence } from "smithers-orchestrator";
import { agent } from "ai";
import { anthropic } from "@ai-sdk/anthropic";

const { Workflow, useCtx, smithers } = createSmithers({
  analyze: analyzeSchema,
  fix: fixSchema,
});
```

`createSmithers` handles everything: SQLite database, Drizzle tables, schema validation, context provider. You get back a typed `Workflow` component, a `useCtx()` hook, and a `smithers()` function to export your workflow.

### 3. Define your agents

```ts
const analyzer = agent({
  model: anthropic("claude-sonnet-4-20250514"),
  system: "You are a code analyst. Return structured JSON.",
});

const fixer = agent({
  model: anthropic("claude-sonnet-4-20250514"),
  system: "You are a senior engineer who writes minimal, correct fixes.",
});
```

### 4. Build your workflow

```tsx
export default smithers((ctx) => (
  <Workflow name="bugfix">
    <Sequence>
      <Task id="analyze" output="analyze" outputSchema={analyzeSchema} agent={analyzer}>
        {`Analyze the bug: ${ctx.input.description}`}
      </Task>
      <Task id="fix" output="fix" outputSchema={fixSchema} agent={fixer}>
        {`Fix this issue: ${ctx.output("analyze", { nodeId: "analyze" }).summary}`}
      </Task>
    </Sequence>
  </Workflow>
));
```

### 5. Run it

```bash
bunx smithers run workflow.tsx --input '{"description": "Auth tokens expire silently"}'
```

Or programmatically:

```ts
import { runWorkflow } from "smithers-orchestrator";
import workflow from "./workflow";

const result = await runWorkflow(workflow, {
  input: { description: "Auth tokens expire silently" },
});
```

## Core Concepts

### Components as pipeline stages

Every stage in your pipeline is a React component. This means you get composition, reuse, and conditional rendering for free.

```tsx
function CodeReview({ fileGlob }: { fileGlob: string }) {
  const ctx = useCtx();
  return (
    <Sequence>
      <Task id="lint" output="lint" outputSchema={lintSchema} agent={linter}>
        {`Lint files matching ${fileGlob}`}
      </Task>
      <Task id="review" output="review" outputSchema={reviewSchema} agent={reviewer}>
        {`Review the lint results: ${JSON.stringify(ctx.latest("lint", "lint"))}`}
      </Task>
    </Sequence>
  );
}

// Reuse it
<Parallel>
  <CodeReview fileGlob="src/**/*.ts" />
  <CodeReview fileGlob="tests/**/*.ts" />
</Parallel>
```

### Structured output with Zod

Every task output is validated against its Zod schema. If the agent returns malformed JSON, Smithers automatically retries with the validation error appended to the prompt — the agent self-corrects.

```tsx
<Task
  id="analyze"
  output="analyze"
  outputSchema={analyzeSchema}
  agent={analyzer}
  retries={2}
>
  Analyze the codebase for security issues
</Task>
```

### MDX prompts

Complex prompts get unwieldy as template literals. Use MDX instead — it renders to clean markdown, not HTML.

```mdx
{/* prompts/analyze.mdx */}
# Security Analysis

Analyze **{props.target}** for vulnerabilities.

## Focus areas
- {props.focus}
- Input validation
- Authentication flows
```

```tsx
import { mdxPlugin } from "smithers-orchestrator";
import AnalyzePrompt from "./prompts/analyze.mdx";

mdxPlugin(); // register once

<Task id="analyze" output="analyze" agent={analyzer}>
  <AnalyzePrompt target="src/auth" focus="token handling" />
</Task>
```

### Validation loops with Ralph

`<Ralph>` re-runs its children until a condition is met. Each iteration is tracked separately in the database with an `iteration` counter.

```tsx
<Ralph
  until={ctx.latest("review", "validate")?.approved}
  maxIterations={5}
>
  <Task id="implement" output="implement" agent={coder}>
    {`Fix based on feedback: ${ctx.latest("review", "validate")?.feedback ?? "Initial implementation"}`}
  </Task>
  <Task id="validate" output="review" agent={reviewer}>
    {`Review the implementation: ${ctx.latest("implement", "implement")?.code}`}
  </Task>
</Ralph>
```

### Dynamic branching

The workflow tree re-renders after each task. Use standard JSX conditionals to create dynamic plans.

```tsx
<Task id="assess" output="assess" agent={analyst}>
  Assess the complexity of this task
</Task>

{ctx.output("assess", { nodeId: "assess" }).complexity === "high" ? (
  <Sequence>
    <Task id="plan" output="plan" agent={architect}>Plan the implementation</Task>
    <Task id="implement" output="code" agent={coder}>
      {`Follow this plan: ${ctx.output("plan", { nodeId: "plan" }).steps}`}
    </Task>
  </Sequence>
) : (
  <Task id="implement" output="code" agent={coder}>
    Quick fix for the issue
  </Task>
)}
```

## Components

| Component | Purpose | Key Props |
|-----------|---------|-----------|
| `<Workflow>` | Root container | `name`, `cache` |
| `<Task>` | Single AI or static task | `id`, `output`, `agent`, `outputSchema`, `retries` |
| `<Sequence>` | Run children in order | `skipIf` |
| `<Parallel>` | Run children concurrently | `maxConcurrency`, `skipIf` |
| `<Branch>` | Conditional execution | `if`, `then`, `else` |
| `<Ralph>` | Loop until condition met | `until`, `maxIterations` |

## Context API

```tsx
ctx.input                                          // workflow input
ctx.output("analyze", { nodeId: "analyze" })       // specific row by string key
ctx.output(table, { nodeId: "analyze" })           // specific row by table object
ctx.latest("analyze", "analyze")                   // latest iteration for a node
ctx.latestArray(value, zodSchema)                  // parse + validate array field
ctx.iterationCount("analyze", "analyze")           // count iterations for a node
ctx.runId                                          // current run ID
ctx.iteration                                      // current Ralph iteration
```

Access context inside components with the `useCtx()` hook:

```tsx
const { Workflow, useCtx, smithers } = createSmithers({ ... });

function MyComponent() {
  const ctx = useCtx();
  return <>{`Process: ${ctx.input.description}`}</>;
}
```

## Built-in Tools

```tsx
import { read, edit, bash, grep, write } from "smithers-orchestrator/tools";

const codeAgent = agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { read, edit, bash, grep, write },
  system: "You are a senior software engineer.",
});
```

All tools are sandboxed to the workflow root directory. `bash` is network-disabled by default.

## How It Works

1. **Define** — Zod schemas become SQLite tables. React components become your DAG.
2. **Render** — Smithers renders the React tree, identifies runnable tasks (depth-first, left-to-right).
3. **Execute** — The engine runs each task, validates output against the schema, writes to SQLite.
4. **Re-render** — The tree re-renders with updated context. Newly unblocked tasks become runnable.
5. **Repeat** — Until no runnable tasks remain. Crash at any point and resume from the last checkpoint.

Every task result is a row in SQLite keyed by `(runId, nodeId, iteration)`. There is no in-memory state to lose.

## CLI

```bash
smithers run workflow.tsx --input '{"description": "Fix bugs"}'
smithers resume workflow.tsx --run-id abc123
smithers list workflow.tsx
smithers approve workflow.tsx --run-id abc123 --node-id review
```

## Server Mode

```ts
import { startServer } from "smithers-orchestrator/server";

startServer({
  port: 7331,
  authToken: process.env.SMITHERS_API_KEY,
});
```

## License

MIT
