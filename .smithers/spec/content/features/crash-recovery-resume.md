# Crash recovery, supervisor, and resume

> **Status:** Partial | **Priority:** P0 | **Owner:** smithers-maintainers | **Group:** Recover & replay

Runs resume after process death, quota waits, restarts, detached-owner exits, and durable wait states; the supervisor can detect stale owners and resume bounded numbers of abandoned runs.

## What you can do

Kill the process, close a laptop, exhaust quota, or pause for approval, then continue from the last persisted decision instead of starting over.

## Capabilities

### Resume

`smithers up/resume` restores in-flight runs from the store.

### Quota recovery

retry-task recovers runs that exhausted retries on provider rate limits.

### Resume by run id

`smithers up` --resume restores persisted input, outputs, metadata, owner state, and frame snapshots.

### Stale owner detection

supervise detects heartbeat-stale runs and resumes them with concurrency limits.

### Quota-aware waits

AGENT\_QUOTA\_EXCEEDED pauses without burning retry attempts and carries reset metadata.

### Detached pause model

Foreground and detached owners exit at `waiting-approval/event/timer` states while persisted state records the blocker.

## Endpoints and commands

- `CLI smithers up --resume` ([docs](docs/cli/overview.mdx))
- `CLI smithers supervise` ([docs](docs/cli/overview.mdx))
- `RPC resumeRun` ([docs](docs/rpc/resume-run.mdx))

## Related docs

- [Durability and resume](docs/how-it-works.mdx#durability--resume)
- [CLI pauses and resume](docs/cli/overview.mdx#pauses-resume-and-detached-runs)

## Test cases

- `packages/engine/tests/crash-recovery.test.js`
- `packages/scheduler/tests/workflowSession-quota.test.js`
- `apps/cli/tests/supervisor-core.test.js`
- `apps/cli/tests/supervisor-e2e.test.js`
- `apps/cli/tests/post-failure-trigger.e2e.test.js`
- `e2e/faults/case01-kill-engine-mid-task.test.ts`
- `e2e/faults/case06-concurrent-resume-vs-supervisor.test.ts`
- `e2e/faults/case31-real-engine-kill-resume.test.ts`

## Observability

- Supervisor metrics include supervisorStaleDetected and supervisorPollDuration.
- Heartbeat freshness, owner claims, run state, and waiting reason appear in `ps/inspect/why` output.

## Debugging

- Run `smithers why` <runId> before forcing resume to understand owner, heartbeat, approval, signal, or timer blockers.
- RESUME\_METADATA\_MISMATCH means workflow source or metadata changed; start a fresh run or fork instead of forcing stale code.

## Architecture

- `apps/cli/src/supervisor.js` and resume-detached.js own stale-run polling and detached resume paths.
- `packages/engine/src/runtime-owner.js` and isRunHeartbeatFresh `record/process` owner state.
- `docs/how-it-works.mdx` documents stable task IDs and resume hash validation.

## Fixes and diffs

- 2026-07-06 refresh: read README.md, package exports, selected package entry points, `docs/how-it-works.mdx`, `docs/cli/overview.mdx`, `docs/agents/overview.mdx`, `docs/integrations/custom-ui.mdx`, `docs/integrations/mcp-server.mdx`, `docs/deployment/production-hardening.mdx`, `docs/deployment/control-plane.mdx`, and targeted test inventories.
- 2026-07-18 feature and docs audit: removed an expected workflow-hash safety rule from the gap list and retained the one unproved dogfood workflow path.
- `apps/cli/src/supervisor.js`
- `apps/cli/src/resume-detached.js`
- `packages/engine/src/runtime-owner.js`
- `packages/scheduler/src/makeWorkflowSession.js`
- `e2e/faults/case06-concurrent-resume-vs-supervisor.test.ts`

## Open gaps

- The built-in crash-recovery dogfood workflow still lacks a dedicated workflow-level e2e; real engine `kill/resume` behavior is covered independently by fault case31.
