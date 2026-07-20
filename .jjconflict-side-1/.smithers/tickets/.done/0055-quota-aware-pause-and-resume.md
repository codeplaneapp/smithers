# Quota-aware pause & resume (don't burn retries on usage-limit errors)

> Target repo: **smithers** (this repo)
> Source: GitHub issue [#324](https://github.com/smithersai/smithers/issues/324) · found running `.smithers/workflows/fix-all-issues.tsx`
> Status: **DONE** (landed 2026-06-20) — quota errors now route to a durable `waiting-quota` status and do **not** consume task retries; #324 closed 2026-06-21, archived to `.done/`. Re-verified against source 2026-06-22. Related: [[0054-degraded-partial-failure-run-status]].

## Problem

When an agent provider returns a **usage-limit / quota** error (e.g. Codex on a ChatGPT subscription: `You've hit your usage limit … try again at Jun 18th, 2026 9:54 AM`), Smithers treats it like any task failure: it burns the task's `retries` immediately (each attempt fails in ~3s), and with `continueOnFail` + `<Loop onMaxReached="return-last">` the work item silently converges to "no PR / not done." A large fan-out then quietly degrades — many items produce nothing — and combined with #295 the run can still report `succeeded`.

Observed running fix-all-issues 8-wide: the ChatGPT Codex quota was exhausted ~50 min in; within minutes the log had 20 `hit your usage limit` errors and every subsequent Codex `fix`/`review-codex` task failed in ~3s, burning its retries. The run had to be cancelled (12 PRs landed, ~477 steps pending) to preserve state; otherwise the ~120 pending items would have churned their loop/retry budgets to no-PR and been unrecoverable on resume (loops would hit `maxIterations`).

A quota error is **transient and resumable** (it even carries a concrete reset time), unlike a logic failure. Smithers already short-circuits retries for auth errors (`task.mdx`: "Auth errors short-circuit retries"); usage-limit errors should be handled at least as gracefully.

## Suggested solution

- [x] Detect provider usage-limit/rate/quota errors (parse the reset time when present) and **do not** consume the task's `retries`.
- [x] Prefer **pausing the run** into a durable, resumable state — a dedicated status (e.g. `waiting-quota`) with the reset time surfaced — rather than failing the task, so `smithers up --run-id … --resume true` after the reset completes the remaining work instead of leaving silently-skipped items.
- [x] At minimum, back off / requeue rather than spin through every task at the failure rate.
- [x] Surface an aggregate "N tasks blocked on provider quota" signal (ties into [[0054-degraded-partial-failure-run-status]]).

## Acceptance

- [x] A usage-limit error does not decrement `retries` and does not converge a `<Loop>` item to no-PR.
- [x] The run can durably pause on quota exhaustion and resume cleanly after the reset time.
- [x] An aggregate quota-blocked count is observable (CLI/inspect).

## Implementation (verified 2026-06-22)

- Detection: `classifyQuotaError` (`packages/agents`) maps provider usage-limit text → `AGENT_QUOTA_EXCEEDED` / `failureQuota`, parsing the reset time; `isQuotaFailure`/`isQuotaTaskFailure` in `packages/scheduler/src/makeWorkflowSession.js` + `packages/engine/src/engine.js` exclude quota attempts from the retry-consuming set.
- Durable pause: `waiting-quota` status threads through `packages/driver/src/RunStatus.ts`, `packages/scheduler/src/RunResult.ts`, `packages/db/src/runState/RunState.ts`; reset time persisted in `errorJson` and surfaced via `deriveRunState` (`blocked.kind="quota"`, `quotaBlockedCount`, `resetAtMs`).
- Tests: `packages/scheduler/tests/workflowSession-quota.test.js`, `packages/agents/tests/classifyQuotaError.test.js`, `packages/engine/tests/engine-internals.test.js` (quota DB round-trip / retry-budget preservation).
