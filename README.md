# Smithers

Smithers powers TypeScript teams to run long AI coding workflows that survive crashes and handle approvals, retries, and restarts

## Getting started

```bash
bunx smithers-orchestrator@latest init
```

This will scaffold a `.smithers/` folder with common simple preconfigured workflows ready to use right away.

Use the `smithers` cli to work with smithers.

## [See Docs](https://smithers.sh)

## Example

```tsx
import { createSmithers, Sequence } from "smithers-orchestrator";
import { z } from "zod";

const { Workflow, Task, smithers, outputs } = createSmithers({
  analyze: z.object({
    summary: z.string(),
    severity: z.enum(["low", "medium", "high"]),
  }),
  fix: z.object({
    patch: z.string(),
    explanation: z.string(),
  }),
});

export default smithers((ctx) => (
  <Workflow name="bugfix">
    <Sequence>
      <Task id="analyze" output={outputs.analyze} agent={analyzer}>
        {`Analyze the bug: ${ctx.input.description}`}
      </Task>

      <Task id="fix" output={outputs.fix} agent={fixer}>
        {`Fix this issue: ${ctx.output("analyze", { nodeId: "analyze" }).summary}`}
      </Task>
    </Sequence>
  </Workflow>
));
```

Each task output is validated against its Zod schema and persisted to SQLite. If the process crashes, Smithers resumes from the last completed node.

## Components

| Component    | Purpose                        |
| ------------ | ------------------------------ |
| `<Workflow>` | Root container                 |
| `<Task>`     | AI or static task node         |
| `<Sequence>` | Ordered execution              |
| `<Parallel>` | Concurrent execution           |
| `<Branch>`   | Conditional execution          |
| `<Ralph>`    | Loop until condition satisfied |

## Looping with `<Ralph>`

```tsx
<Ralph until={ctx.latest("validate")?.approved} maxIterations={5}>
  <Task id="implement" output={outputs.implement} agent={coder}>
    Fix based on feedback
  </Task>

  <Task id="validate" output={outputs.review} agent={reviewer}>
    Review the implementation
  </Task>
</Ralph>
```

## CLI

```bash
smithers up workflow.tsx --input '{"description": "Fix bug"}'
smithers up workflow.tsx --run-id abc123 --resume true
smithers eval workflow.tsx --cases evals/smoke.jsonl --suite smoke
smithers ps
smithers workflow list
smithers approve abc123 --node review
```

## Eval suites

Run repeatable workflow regressions from JSON or JSONL cases:

```jsonl
{"id":"happy-path","input":{"description":"Fix bug"},"expected":{"status":"finished"}}
```

```bash
smithers eval workflow.tsx --cases evals/smoke.jsonl --suite smoke --force
```

Reports are written to `.smithers/evals/<suite>.json` and the command exits non-zero when any case fails.

## Hot Reload

```bash
smithers up workflow.tsx --hot
```

Edit prompts, config, agent settings, or JSX structure while a run is executing. In-flight tasks finish with their original code; only newly scheduled tasks pick up changes.

Output schema changes and database path changes require a restart.

## License

MIT
