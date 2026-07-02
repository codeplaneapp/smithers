# Smithers - product overview

Smithers is a durable control plane for long-running coding agents. You write
a workflow as a small TSX file, and Smithers runs it: scheduling agent tasks,
persisting every decision, retrying failures, pausing for human approval, and
resuming after crashes, rate limits, or restarts. The status of every product
surface is tracked in `.smithers/spec/features.json` and rendered as the
feature matrix; each feature has a derived spec doc under `features/`.

## What it is

A workflow is JSX: `Workflow`, `Sequence`, `Parallel`, `Loop`, `Task`,
`Approval`, `Worktree`. Tasks carry zod-typed outputs, so downstream steps get
structured data, not prose. Tasks run real agents (Claude Code, Codex,
OpenCode, Pi, Kimi, Amp, Antigravity) or plain compute functions. The engine
writes every event to a local store (SQLite or PGlite, Postgres in the cloud),
which is what makes runs durable: kill the process and `smithers up` continues
from the last persisted decision.

Around the engine sits the rest of the product. The `smithers` CLI launches
and inspects runs, and doubles as an MCP server. The gateway exposes runs,
live events, and approvals over HTTP/WS so UIs and remote clients can watch
and steer. `smithers ui` serves per-workflow custom dashboards written in
React against gateway-react hooks. Time travel lets you rewind, fork, and
replay a persisted run. Worktrees isolate each agent in its own checkout so
parallel work cannot stomp your tree.

## Principles

1. **Durability is the product.** Nothing important lives only in process
   memory. A run that dies must resume without repeating finished work.
2. **No fake success.** A feature's status in this spec is what we can prove
   with tests or direct evidence. Prefer partial over fixed when unsure.
3. **Real backends in tests.** No mocked gateways or fabricated data; e2e
   means a real store, real processes, and where feasible real agents.
4. **Dogfood.** Internal multi-step processes run as smithers system
   workflows, not one-off imperative scripts.

## How this spec is maintained

The `docs-driven-development` workflow (itself a feature below) audits the
product, updates `features.json` honestly, derives the per-feature docs with
`bun .smithers/lib/ddd/build.ts`, and dispatches agents to close the highest
value gaps each round. Derived docs under `features/` are never hand-edited;
change `features.json` or this overview instead.
