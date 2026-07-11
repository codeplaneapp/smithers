# Durable engine, scheduler, and driver

> **Status:** Fixed | **Priority:** P0 | **Owner:** smithers-maintainers | **Group:** Run & observe | **Tier:** Platform

The core control plane renders workflow frames, schedules ready nodes, executes `agent/compute/static` tasks, validates structured outputs, persists every state transition, and resumes from durable state after failures.

## What you can do

Long coding-agent runs keep progressing through retries, rate limits, process exits, and machine restarts without repeating completed work.

## Capabilities

### Retries & timeouts

Per-task retries, timeoutMs, heartbeatTimeoutMs.

### Deadlock detection

DEPENDENCY\_DEADLOCK instead of silent hangs on bad `deps/needs` keys.

### Frame persistence

Each render frame and task completion writes durable rows before the next decision.

### Retries and waits

Retry policies, heartbeat timeouts, quota waits, timers, approvals, and external signals are first-class wait reasons.

### Scheduler safety

Dependency deadlocks and stale completions surface explicit failures instead of silent hangs.

### Postgres/PGlite path

createSmithersPostgres and the SQL dialect layer run the same engine against managed or embedded Postgres-family stores.

## Endpoints and commands

- `API runWorkflow(workflow, input, options)` ([docs](docs/runtime/run-workflow.mdx))
- `API renderFrame(workflow, state)` ([docs](docs/runtime/render-frame.mdx))
- `CLI smithers up <workflow>` ([docs](docs/cli/overview.mdx))

## Related docs

- [How it works](docs/how-it-works.mdx)
- [Run state](docs/runtime/run-state.mdx)
- [Runtime events](docs/runtime/events.mdx)

## Test cases

- `packages/engine/tests/durability.test.jsx`
- `packages/engine/tests/crash-recovery.test.js`
- `packages/engine/tests/engine-transactional-writes.test.jsx`
- `packages/engine/tests/create-smithers-postgres.test.jsx`
- `packages/scheduler/tests/workflowSession-quota.test.js`
- `packages/scheduler/tests/workflowSession-degraded.test.js`
- `packages/driver/tests/pause-drain.test.js`
- `e2e/faults/case31-real-engine-kill-resume.test.ts`

## Observability

- Engine metrics include runsTotal, nodesStarted, nodesFinished, nodesFailed, nodeDuration, attemptDuration, `cacheHits/cacheMisses`, and tool duration.
- Persisted events and frame snapshots back CLI `logs/events/tree`, Gateway streamRunEvents, DevTools snapshots, and time-travel timeline views.

## Debugging

- Use `smithers inspect`, events, tree, and node to inspect frame state and attempts.
- Use e2e fault cases for process-kill, `approval/event/timer` restart, websocket reconnect, and rewind regression reproduction.

## Architecture

- `packages/engine/src/index.js` exports runWorkflow, renderFrame, approvals, signals, events, hot reload, and Effect bridge modules.
- `packages/scheduler/src/index.js` exports plan building, task scheduling, retry delay computation, and WorkflowSession.
- `packages/driver/src/index.js` exports WorkflowDriver and SmithersCtx, the higher-level loop used by modern execution paths.

## Fixes and diffs

- 2026-07-06 refresh: read README.md, package exports, selected package entry points, `docs/how-it-works.mdx`, `docs/cli/overview.mdx`, `docs/agents/overview.mdx`, `docs/integrations/custom-ui.mdx`, `docs/integrations/mcp-server.mdx`, `docs/deployment/production-hardening.mdx`, `docs/deployment/control-plane.mdx`, and targeted test inventories.
- 2026-07-06 review: `bun test --timeout`=120000 --max-concurrency=1 for the eight listed durable-engine test files passed.
- `packages/engine/src/engine.js`
- `packages/driver/src/WorkflowDriver.js`
- `packages/scheduler/src/makeWorkflowSession.js`
- `packages/db/src/adapter.js`
- `e2e/faults/*.test.ts`
