# Degraded / partial-failure run status

> Target repo: **smithers** (this repo)
> Source: GitHub issue [#295](https://github.com/smithersai/smithers/issues/295) · surfaced by the agent-fluency eval `ru-run-completed-but-failed`
> Status 2026-06-18: **open, not started.** The auto-fix workflow declined this as a deliberate run-status-model change warranting a hand-designed PR (engine + db + gateway + UI). Related: [[0055-quota-aware-pause-and-resume]].

## Problem

Run terminal status is binary (`finished` | `failed`). A run is only `failed` when `unhandledFailureDecision()` finds a failed task (`packages/scheduler/src/makeWorkflowSession.js:433`), but that function **skips** both `continueOnFail` failures (`:438`) and transient agent failures (`:442-444`, via `isTransientSessionFailure` matching `SESSION_ERROR`/`TASK_TIMEOUT`/`TASK_HEARTBEAT_TIMEOUT`/`TASK_ABORTED`/`failureRetryable`). With those skipped, `decide()` falls through to `finishedResult()` (`:676`), which carries only `{ runId, status, output }` — no failed-child count. `scheduleTasks.js` reinforces this: a `parallel` node is reported failed only when *every* child failed (`:158-168`).

Result: a fan-out where 9 of 10 agents fail still reports `status: finished` → `succeeded` (`docs/runtime/run-state.mdx:41`), with no programmatic signal that the run finished degraded. The rubric for `ru-run-completed-but-failed` requires acknowledging that a `completed` status can mask failed children — today the masking is unavoidable.

## Suggested solution

1. **Track the degraded outcome** — in `decide()` / `finishedResult()`, when the run reaches `finished` but `state.failures` holds tasks excluded by the `:438`/`:442` skips, record those keys and surface them: extend `finishedResult` output with `{ failedChildren: number, failedChildKeys: string[] }`. **This (1) alone is the minimum viable fix** — surface `failedChildren` on the result and in `smithers inspect`.
2. **Add a degraded terminal status** — introduce `"degraded"`/`"partial"` to `packages/scheduler/src/RunResult.ts` and `packages/engine/src/effect/RunStatusSchema.ts`, returned by `finishedResult()` when `failedChildren > 0`, mapping to a distinct `RunState` (e.g. `succeeded-with-failures`) in `docs/runtime/run-state.mdx`. Keep it terminal/non-fatal so `continueOnFail` semantics still don't abort the run; gate so existing `finished === success` callers keep working.
3. **Emit an event** — persist a `RunStatusChanged`/`RunDegraded` record carrying the failed-child count so CLI/Gateway/DevTools render it without re-deriving from per-node rows.

## Acceptance

- [ ] `finishedResult()` carries `failedChildren` + `failedChildKeys`; `smithers inspect` surfaces them.
- [ ] A degraded/partial terminal status exists and is documented in `docs/runtime/run-state.mdx` with its `RunState` mapping.
- [ ] Existing `continueOnFail` runs still don't abort; `finished === success` callers unaffected.
- [ ] An event row records the failed-child count for the CLI/Gateway/DevTools.
- [ ] The `ru-run-completed-but-failed` eval passes with the new signal.
