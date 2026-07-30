# smthrs

**Run long-horizon coding-agent work as durable workflows.**

[![npm](https://img.shields.io/npm/v/smthrs?color=2563eb&label=npm)](https://www.npmjs.com/package/smthrs)
[![License: MIT](https://img.shields.io/badge/license-MIT-2563eb)](https://github.com/smithersai/smithers/blob/main/LICENSE)
[![Docs](https://img.shields.io/badge/docs-smithers.sh-2563eb)](https://smithers.sh)

Tell your coding agent to do real, multi-step work, then Smithers runs it for minutes or
days with crash recovery, retries, human approvals, and full observability. The same
workflow runs across Claude Code, Codex, Cursor, Pi, AI SDK models, and remote sandboxes.

This package is the published Smithers runtime: the engine, the `smithers` CLI, the JSX
workflow primitives, the agent adapters, and the Gateway. Install it once and your coding
agent drives the rest.

![Live workflow runs: some succeeded, some running, some paused on an approval gate, every run resumable and rewindable.](https://raw.githubusercontent.com/smithersai/smithers/main/marketing/0.22.0/assets/runs-live.gif)

*Watch every step of a workflow run, pause execution, approve gates, and rewind to an
earlier checkpoint. Independent steps can run at the same time.*

## What you get

- 🛡️ **Durable runs that survive crashes**: every completed step is persisted the moment it
  finishes, so a run resumes from where it stopped instead of starting over.
- 🔌 **Any agent, any model**: Claude Code, Codex, Cursor, Pi, Antigravity, and more, plus any model
  through the AI SDK. Swap the harness without rewriting the workflow.
- 🛠️ **Higher-quality output**: review loops, human approvals, and evals give agents the
  structure that real work demands.
- 🧩 **A workflow builder, not a fixed library**: `init` installs a focused authoring
  pack (`create-workflow`, `create-skill`, `docs-driven-development`); your agent
  designs, scaffolds, and documents new workflows — planning, implementation, review,
  debugging, tickets, audits, long-horizon missions — from a plain-English ask.

## When to use Smithers

Smithers is the durable runtime for *coding-agent* work: when the unit of work is an agent
editing a real repository over many steps, and you need that work to be inspectable,
approvable, and recoverable. Use it when order matters across multiple AI steps, you need
crash recovery, a human must approve or answer mid-run, or different tasks need different
models. For a single prompt → single response, call your model provider's SDK directly;
Smithers adds nothing there.

## Get started

Smithers is driven by your coding agent, **not** a GUI you click. Your agent runs Smithers
on your behalf: it scaffolds workflows, kicks off runs, watches them, and handles
approvals.

One command sets everything up. From inside your project:

```bash
bunx smthrs init
```

`init` does everything:

- **Installs the `smithers` skill** into the coding agents on your machine (Claude Code,
  Pi, and more), so your agent knows how and when to use Smithers. No `mkdir`, no `curl`.
- **Scaffolds `.smithers/`** with a focused authoring pack — `create-workflow`,
  `create-skill`, and `docs-driven-development` — so your agent builds the exact
  workflow you need instead of picking from a fixed library. Former starter
  workflows (`hello`, `plan`, `review`, `debug`, and more) are preserved as
  copyable patterns under `examples/init-pack/`.

Then just ask:

> *"orchestrate an agent to add rate limiting and keep iterating until the tests pass."*

Your agent picks the right workflow, starts the run, and keeps going through retries and
review loops until the work is actually done.

> **Always run `bunx smthrs`, never `bunx smithers`.** On npm, `smithers`
> is an unrelated package. The installed binary alias `smithers` is only safe inside a
> project that resolves `node_modules/.bin/smithers`.

To wire the MCP server into every detected agent too, run
`bunx smthrs mcp add`. See [Agent Support](https://smithers.sh/agents/overview)
for the full per-agent matrix.

## Drive it yourself

Prefer the CLI? Ask `create-workflow` to build something for you:

```bash
# describe the workflow you want; create-workflow clarifies, scaffolds, and documents it
bunx smthrs workflow run create-workflow --prompt "add rate limiting, audit logging, and API key rotation"
```

Or copy one of the 29 archived starter patterns (`hello`, `plan`, `review`, `debug`, and
more) from `examples/init-pack/` into `.smithers/workflows/` and run it directly — see
`examples/init-pack/README.md` for the full inventory.

Watch what's happening, whether your agent started the run or you did:

```bash
bunx smthrs ps              # list active, paused, and recently completed runs
bunx smthrs inspect RUN_ID  # steps, agents, approvals, and outputs for one run
bunx smthrs logs RUN_ID     # tail the event log
bunx smthrs chat RUN_ID     # read the agent's chat output
```

Run `bunx smthrs starters` to browse plain-English starters, and
`bunx smthrs workflow list` to see what's installed.

## Durable by default

Durability is the differentiator. Runs survive crashes, restarts, and flaky tools because
**every completed step is persisted to SQLite the moment it finishes**. The runtime always
knows what's done and what to run next. Approvals, human questions, retries, and replay are
first-class.

```text
prompt → render workflow → run task → validate output → persist to SQLite → re-render → resume · inspect · replay
```

That loop is the whole model: a task runs, its output is validated against a schema and
written down, then the workflow re-renders from persisted state to decide the next task. A
crash at any point resumes from the last write, not from the top.

```bash
bunx smthrs up workflow.tsx --input '{"description":"Fix bug"}'
bunx smthrs up workflow.tsx --run-id abc123 --resume true   # resume after a crash
bunx smthrs rewind abc123 --frame 4                          # time-travel to an earlier frame
bunx smthrs fork abc123                                      # branch an alternate timeline
bunx smthrs replay abc123                                    # replay from a checkpoint
```

## Author your own

The curated init workflows are normal Smithers TSX files, and the archived starter catalog
under `examples/init-pack/` remains available to copy or adapt. Run `create-workflow` to
author a repository-specific workflow from the same primitives. A workflow is a JSX tree of
tasks, each with a Zod-validated output:

```tsx
import { createSmithers, Sequence } from "smthrs";
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
        {`Fix this issue: ${ctx.latest("analyze").summary}`}
      </Task>
    </Sequence>
  </Workflow>
));
```

Each task output is validated against its Zod schema and persisted to SQLite. If the
process crashes, Smithers resumes from the last completed node without re-running finished
work.

| Component    | Purpose                               |
| ------------ | ------------------------------------- |
| `<Workflow>` | Root container                        |
| `<Task>`     | AI or static task node                |
| `<Sequence>` | Ordered execution                     |
| `<Parallel>` | Concurrent execution                  |
| `<Branch>`   | Conditional execution                 |
| `<Loop>`     | Repeat tasks until a condition is met |

There are many more: approvals, merge queues, sub-workflows, signals, timers, sagas,
sandboxes, and composite patterns. See
[Components](https://smithers.sh/components/workflow).

## Package entry points

The main entry re-exports the full toolkit, so most code only needs
`import { ... } from "smthrs"`. Dedicated subpaths exist for focused imports:

| Import | What it gives you |
| --- | --- |
| `smthrs` | `createSmithers`, the workflow components, agent adapters, errors, and the rest of the core API. |
| `smthrs/tools` | The built-in agent tool sandbox. |
| `smthrs/gateway-client` | Typed client for the Gateway RPC/WS control plane. |
| `smthrs/gateway-react` | React hooks for live, multi-run state. |
| `smthrs/sandbox` | The `<Sandbox>` primitive and `SandboxProvider` interface. |
| `smthrs/microsandbox` | The first-class Microsandbox microVM provider. |
| `smthrs/control-plane` | Programmatic control-plane API for launching and steering runs. |
| `smthrs/server` | The Gateway server (`startServer`, `createServeApp`). |
| `smthrs/observability` | Prometheus metrics and OpenTelemetry tracing layers. |
| `smthrs/memory` | Cross-run memory store and recall. |
| `smthrs/scorers` | Eval scorers (LLM-judge, relevancy, faithfulness, …). |
| `smthrs/openapi` | Generate AI SDK tools from OpenAPI specs. |

## Any agent, any model

Point each task at whichever agent is best for the job, mix several in one workflow, and
switch freely. The workflow doesn't change when the model does, so a frontier model can
plan, a fast model can fan out, and a specialized harness can do the edits.

Agent adapters ship in the box, including `ClaudeCodeAgent`, `CodexAgent`, `CursorAgent`, `PiAgent`,
[`NanocodexAgent`](https://smithers.sh/integrations/nanocodex), `AntigravityAgent`, `GeminiAgent`, and `AnthropicAgent` / `OpenAIAgent` for any AI
SDK model (with tools, structured output, and MCP). The same `<Sandbox>` primitive runs an
agent in a local hardware-isolated microVM with
[Microsandbox](https://github.com/superradcompany/microsandbox), through Bubblewrap or
Docker, or on any backend you implement against `SandboxProvider`.

## Requirements

- [Bun](https://bun.sh) ≥ 1.3
- TypeScript ≥ 5 (only for authoring TSX workflows)
- Model or provider credentials (e.g. `ANTHROPIC_API_KEY`)
- A version control system for snapshotting and isolating agent work:
  [jj (Jujutsu)](https://github.com/jj-vcs/jj) or [git](https://git-scm.com). jj is
  preferred and powers durability, time-travel, and per-task worktrees; the optional
  `@smthrs/jj-<platform>` package bundles a jj binary so a fresh install
  works with no system jj.

## Docs

Full documentation lives at **[smithers.sh](https://smithers.sh)**.

- [Introduction](https://smithers.sh/introduction) — what Smithers is and when to use it.
- [Quickstart](https://smithers.sh/quickstart) — scaffold and run a workflow in two commands.
- [Tour](https://smithers.sh/tour) — a guided walk through a real run.
- [How It Works](https://smithers.sh/how-it-works) — the durable execution model.
- [Components](https://smithers.sh/components/workflow) — the full primitive set.

## License

MIT
