# Smithers - product overview

Smithers is a durable control plane for long-running coding-agent work. You write a workflow as a small TSX/JSX tree, then Smithers renders it into a task graph, executes real agents or compute functions, validates typed outputs, persists every decision, and re-renders from durable state until the run finishes or reaches a human/external wait.

The product in this repository is the runtime and local control plane: published packages under packages/*, the smithers CLI in apps/cli, observability integrations in apps/observability, review support in apps/review, the seeded .smithers workflow pack, docs, skills, and e2e fault suites. The product UI that matters here is the smithers ui surface for workflow-owned dashboards under .smithers/ui/*.tsx, not a separate SaaS app.

## What it is

A workflow is React for work: Workflow, Task, Sequence, Parallel, Branch, Loop, Approval, HumanTask, Timer, Signal, Sandbox, Worktree, and higher-level components describe what can happen next. createSmithers binds zod schemas to outputs so downstream steps read structured rows through ctx instead of scraping prose. Tasks can call SDK agents in-process, spawn CLI agents such as Claude Code or Codex, run local compute, or run behind an explicit Sandbox provider.

Durability is the core contract. State lives in SQLite, PGlite, or Postgres tables, not process memory. A completed task is not re-executed on resume; a killed or paused run reloads persisted input, outputs, frames, attempts, waits, approvals, events, and owner state. Time travel, replay, fork, snapshots, run inspection, custom UIs, and the gateway all build on that event and frame history.

Around the engine is the operator surface. The smithers CLI installs workflow packs, launches and resumes runs, watches logs, answers approvals, sends signals, manages agent accounts, runs evals, generates OpenAPI tools, migrates storage, starts gateways, opens monitors, and serves MCP tools for other agents. The gateway exposes versioned RPC and WebSocket APIs for runs, approvals, prompts, docs, tickets, memory, scores, cron, and DevTools. gateway-client and gateway-react let browser or desktop UIs consume that API without inventing a second contract.

## What ships here

- packages/smithers: the public facade and package exports.
- packages/engine, scheduler, driver, db, graph, components, react-reconciler: the durable workflow runtime.
- packages/agents, accounts, usage: SDK/CLI agent adapters, capability reports, account and usage helpers.
- packages/gateway, server, gateway-client, gateway-react, gateway-ui: RPC, HTTP/WebSocket, and workflow UI client layers.
- packages/time-travel, vcs, sandbox plus cloud provider packages: rewind, replay, worktrees, local and remote execution boundaries.
- packages/memory, scorers, openapi, integrations, control-plane: optional product modules for memory, evaluation, API tools, webhooks, hosted primitives, and external systems.
- apps/cli, apps/observability, apps/review: the command-line product, metrics/tracing stack, and open-code-review support.
- .smithers/: the built-in workflow pack, workflow UIs, DDD spec workflow, and local dogfooding assets.
- docs/, skills/, e2e/: human/agent docs and no-mocks fault/regression coverage.

## Principles

1. **Durability is the product.** Every meaningful decision must be persisted before Smithers claims progress.
2. **Agents drive it.** Smithers is designed for coding agents to invoke, inspect, and steer through CLI, MCP, and workflow skills.
3. **Real backends over mocks.** Product code and e2e tests use real stores, processes, gateways, and fault paths; fake agents are acceptable only to make CI deterministic.
4. **Explicit boundaries.** Tool sandbox, CLI-agent sandbox policies, and Sandbox provider containers are different boundaries and must be named precisely.
5. **Honest status.** A feature is fixed only when the repo has convincing tests and no known gaps; partial is preferable to pretending.
6. **Dogfood durable workflows.** Internal multi-step processes should be modeled as Smithers workflows when they need retries, approvals, replay, or long-lived state.

## How this spec is maintained

.smithers/spec/features.json is the structured source of truth for feature status, evidence, missing work, architecture notes, observability, debug paths, endpoints, and links. .smithers/spec/content/overview.md is the editable human overview. .smithers/spec/content/features/<id>.md and .smithers/ui/ddd-*.generated.ts are derived by bun .smithers/lib/ddd/build.ts and should not be hand-edited.

The docs-driven-development workflow audits this spec, generates backlog tickets from open gaps, triages the highest-value work, dispatches implementation agents, and reviews the result. Each refresh should read targeted code and docs, preserve existing feature fields unless the repo proves a correction, update feature records honestly, then run the DDD build gate.
