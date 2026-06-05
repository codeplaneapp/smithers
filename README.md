# Smithers

**Orchestrate agents at scale with composable workflows.**

Smithers is a durable runtime for long-running AI coding agents. Install a skill and your
agent writes the workflow — a composable TypeScript tree — then runs it for minutes or
days with crash recovery, retries, human approvals, replay, and full observability across
any agent, any model, and any machine.

- 🧩 **Composable workflows**: sequence, fan out, branch, and loop tasks into workflows
  shaped to your task and your project. Not one giant one-size-fits-all agent.
- 🔌 **Model- and harness-agnostic**: Claude Code, Codex, Pi, Antigravity, and more, plus
  any model through the AI SDK. Swap the harness without rewriting the workflow.
- 🛡️ **Robust by default**: durable execution, retries, replay, time-travel, evals,
  human-in-the-loop approvals, and Prometheus metrics. Operational guarantees no single
  agent gives you.

## Why Smithers

We build Smithers to put power in the hands of builders. You shouldn't have to wait and
see what the model companies decide to ship next. With composable, model- and
harness-agnostic workflows, you can build the future you want to see today, on whatever
model and harness is best this week.

Every decision in Smithers is about making builders **more** powerful, not replacing
them. Where other tools race to swap human craftsmanship for slop, Smithers is built to
get **higher-quality output** out of agents, with the review loops, approvals, evals,
and structure that real work demands.

And we don't believe in one-size-fits-all orchestration. The best results come from
**task-specific and project-specific workflows**, so Smithers ships dozens of them
ready to run, and treats having your agent author new ones as a first-class path.

## Quick start

```bash
# scaffold the workflow pack into .smithers/
bunx smithers-orchestrator init

# break a request into ticket files under .smithers/tickets/
bunx smithers-orchestrator workflow run tickets-create --prompt "add rate limiting, audit logging, and API key rotation"

# implement the tickets, each in its own worktree branch
bunx smithers-orchestrator workflow run kanban
```

`init` scaffolds a `.smithers/` folder preloaded with production-ready workflows for
planning, implementation, review, debugging, tickets, audits, and long-horizon missions.
Run `bunx smithers-orchestrator starters` to browse plain-English starters, and
`smithers workflow list` to see what's installed.

## Run it from your coding agent

Smithers is driven by an AI agent (Claude Code, Codex, and friends), **not** a GUI you
click. Your agent runs Smithers on your behalf: it scaffolds workflows, kicks off runs,
watches them, and handles approvals.

The fastest way to make your agent fluent is the two fan-out commands — they install the
Smithers skill and register the MCP server into **every coding agent on your machine**
(Claude Code, Codex, Cursor, Copilot, Pi, Hermes, OpenClaw, and ~20 more):

```bash
bunx smithers-orchestrator skills add   # install the skill set into every detected agent
bunx smithers-orchestrator mcp add      # register Smithers as an MCP server everywhere
```

Prefer to wire one agent by hand, or want the curated onboarding skill with the full docs
bundle? Drop it in directly:

```bash
mkdir -p ~/.claude/skills/smithers
curl -fsSL https://raw.githubusercontent.com/smithersai/smithers/main/skills/smithers/SKILL.md \
  -o ~/.claude/skills/smithers/SKILL.md
curl -fsSL https://smithers.sh/llms-full.txt \
  -o ~/.claude/skills/smithers/llms-full.txt
```

Then just ask: *"orchestrate an agent to add rate limiting and keep iterating until the
tests pass."* See [Agent Support](https://smithers.sh/agents/overview) for the per-agent
setup (skill, MCP, instructions) for Claude Code, Codex, Cursor, Copilot, Pi, Hermes, and
OpenClaw, and [`skills/smithers/`](./skills/smithers) for the onboarding skill.

## Any agent, any model

Smithers doesn't bet on one lab or one harness. Point a task at whichever agent is best
for the job and switch freely:

- **CLI agents**: [Claude Code](./docs/integrations/cli-agents.mdx), Codex,
  [Pi](./docs/integrations/pi-integration.mdx), Antigravity, and more, driven through
  their own runtimes.
- **SDK agents**: any model the [Vercel AI SDK](./docs/integrations/sdk-agents.mdx)
  supports, with tools, structured output, and MCP.
- **Mix them in one workflow**: let a frontier model plan, a fast model fan out, and a
  specialized harness do the edits. The workflow doesn't change when the model does.

## Built-in workflows

`smithers init` installs a pack of ready-to-run workflows. Point your agent at one and go via `bunx smithers-orchestrator workflow run <id> --prompt "..."`:

| Workflow | What it does |
| --- | --- |
| `implement` | Implement a focused change with validation and review feedback loops. |
| `research-plan-implement` | Research a request, produce a plan, then implement it with validation and review. |
| `plan` | Create a practical implementation plan before code changes begin. |
| `research` | Gather repository and external context before planning or building. |
| `review` | Review current repository changes with one or more configured agents. |
| `debug` | Reproduce, fix, validate, and review a reported bug. |
| `improve-test-coverage` | Find and add high-impact missing tests for the repository. |
| `audit` | Audit feature groups for tests, docs, observability, and maintainability gaps. |
| `feature-enum` | Build or refine a code-backed feature inventory for a repository. |
| `grill-me` | Ask targeted questions until vague requirements become actionable. |
| `ticket-create` / `tickets-create` | Turn a request into one or many structured implementation tickets. |
| `kanban` | Implement ticket files in worktree branches, board-style. |
| `ralph` | Keep working continuously on an open-ended maintenance prompt. |
| `mission` | Run long-horizon work as approved milestones with focused workers and validation. |

See [`docs/workflows/`](./docs/workflows/overview.mdx) for the full pack.

## Examples

The [`examples/`](./examples) folder has 90+ runnable workflows covering real patterns. Copy one as a starting point:

| Example | Pattern |
| --- | --- |
| [`code-review-loop`](./examples/code-review-loop.jsx) | Implement → review → fix, looped until approved. |
| [`coverage-loop`](./examples/coverage-loop.jsx) | Run tests, measure coverage, write tests, repeat to target. |
| [`panel`](./examples/panel.jsx) | N specialist agents review in parallel, a moderator synthesizes. |
| [`debate`](./examples/debate.jsx) | Two agents argue opposing positions; a judge decides. |
| [`supervisor`](./examples/supervisor.jsx) | A boss agent plans and delegates to workers dynamically. |
| [`fan-out-fan-in`](./examples/fan-out-fan-in.jsx) | Split work across N parallel agents, aggregate results. |
| [`parallel-tickets`](./examples/parallel-tickets.jsx) | Triage, run waves of work in parallel, merge-queue the results. |
| [`migration`](./examples/migration.jsx) | Plan → transform files → validate → report. |
| [`pr-shepherd`](./examples/pr-shepherd.jsx) | Watch a PR, gather context, leave structured review comments. |
| [`canary-judge`](./examples/canary-judge.jsx) | Compare stable vs. canary metrics; recommend promote/hold/rollback. |
| [`slo-breach-explainer`](./examples/slo-breach-explainer.jsx) | On an SLO alarm, pull traces/logs/changes and explain the cause. |
| [`repo-janitor`](./examples/repo-janitor.jsx) | On a schedule, clean warnings, stale TODOs, and doc drift. |

## Benchmarks

[`benchmarks/swe-bench-pro`](./benchmarks/swe-bench-pro) runs ScaleAI's
[SWE-Bench Pro](https://github.com/scaleapi/SWE-bench_Pro-os) end to end: a
Smithers workflow (Claude Opus 4.8 implements → Codex 5.5 reviews) authors a
patch for a real repository task, and ScaleAI's own Docker images score it. Every
instance is gated by gold/empty integrity controls so the numbers can't be fudged.

## Author your own

The built-in workflows are normal Smithers TSX files: run them as-is, have your agent
adapt them to your repo, or have it write new ones from the same primitives. A workflow
is a JSX tree of tasks:

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

Each task output is validated against its Zod schema and persisted to SQLite. If the
process crashes, Smithers resumes from the last completed node without re-running
finished work.

### Components

| Component    | Purpose                        |
| ------------ | ------------------------------ |
| `<Workflow>` | Root container                 |
| `<Task>`     | AI or static task node         |
| `<Sequence>` | Ordered execution              |
| `<Parallel>` | Concurrent execution           |
| `<Branch>`   | Conditional execution          |
| `<Ralph>`    | Loop until a condition is met  |

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

There are many more: approvals, merge queues, sub-workflows, signals, timers, sagas, and
composite patterns. See [Components](https://smithers.sh/components/workflow).

## Durable by default

Runs survive crashes, restarts, and flaky tools. Every completed step is persisted the
moment it finishes, so the runtime always knows what's done and what to run next.

```bash
smithers up workflow.tsx --input '{"description":"Fix bug"}'
smithers up workflow.tsx --run-id abc123 --resume true   # resume after a crash
smithers ps                                              # list active runs
smithers rewind abc123 --frame 4                         # time-travel to an earlier frame
```

Approvals, human questions, retries, and replay are first-class. You can rewind a run to
an earlier state and fork alternate timelines.

## Observability

Smithers ships a full observability story, not an afterthought:

```bash
smithers observability up                       # Grafana + Prometheus + Tempo + OTLP collector
smithers up workflow.tsx --serve --metrics      # HTTP API, SSE event stream, and /metrics
```

Every run emits Prometheus metrics and OpenTelemetry traces, so you can see token spend,
task latency, retries, and failures across thousands of runs.

## Evals

Run repeatable workflow regressions from JSON or JSONL cases:

```jsonl
{"id":"happy-path","input":{"description":"Fix bug"},"expected":{"status":"finished"}}
```

```bash
smithers eval workflow.tsx --cases evals/smoke.jsonl --suite smoke --force
```

Reports are written to `.smithers/evals/<suite>.json`, and the command exits non-zero when
any case fails.

## Prompt optimization

Run GEPA-style prompt optimization against an eval suite:

```bash
smithers optimize workflow.tsx \
  --cases evals/smoke.jsonl \
  --suite smoke-gepa \
  --provider cerebras \
  --model gpt-oss-120b \
  --artifact .smithers/optimizations/smoke-gepa.json
```

Smithers runs a baseline eval, generates prompt patches, reruns the suite with the
candidate, and writes the artifact only when the optimized score improves.

## Hot reload

```bash
smithers up workflow.tsx --hot
```

Edit prompts, config, agent settings, or JSX structure while a run is executing. In-flight
tasks finish with their original code; only newly scheduled tasks pick up changes.

## Scale across machines

Most workflows run fine on your laptop. When you need more, like isolation, parallelism, or
horizontal scale, the same `<Sandbox>` primitive runs agents in a local sandbox or on a
remote provider, with no change to the workflow:

- **Local**: run agents in an isolated sandbox on your own machine.
- **Remote**: [gVisor](https://gvisor.dev), Kubernetes, [freestyle.sh](https://freestyle.sh),
  [Daytona](https://daytona.io), and [Cloudflare](https://workers.cloudflare.com).

```tsx
// Run a child workflow through an injectable provider (local or remote).
<Sandbox id="build" provider={freestyleProvider} workflow={migration} input={ctx.input} />
```

See [`examples/freestyle-sandbox-provider`](./docs/examples/freestyle-sandbox-provider.mdx)
and the [Sandbox component](https://smithers.sh/components/sandbox).

## Docs

Full documentation lives at **[smithers.sh](https://smithers.sh)**.

## License

MIT

