# Durable engine, scheduler, and driver

> **Status:** Fixed · **Priority:** P0 · **Owner:** smithers-maintainers · **Group:** Run & observe · **Tier:** Platform

**What you can do:** Long agent runs keep going through crashes, rate limits, and restarts.

The core control plane: renders the workflow graph, schedules tasks with retries/timeouts/heartbeats, persists every decision to the store, and survives process death. Two-path caveat: decisions live in WorkflowDriver/makeWorkflowSession.decide(), not the legacy engine block.

## Capabilities

### Retries & timeouts

Per-task retries, timeoutMs, heartbeatTimeoutMs.

### Deadlock detection

DEPENDENCY_DEADLOCK instead of silent hangs on bad deps/needs keys.




## Test cases

- pnpm -C packages/engine test
- pnpm -C packages/scheduler test
- pnpm -C packages/driver test
- pnpm -C e2e test:faults

## Observability

_None recorded yet._

## Debugging

_None recorded yet._

## Architecture

_None recorded yet._

## Fixes & diffs

_None recorded yet._

## Open gaps

_None recorded yet._

