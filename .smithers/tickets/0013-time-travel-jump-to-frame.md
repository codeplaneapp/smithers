# Add Time-Travel Jump-to-Frame RPC

> Quality bar: spec §9. **This RPC is destructive. Extra rigor required:
> single-flight, audit log, rollback semantics, full integration coverage.**

## Context

Spec: `.smithers/specs/live-run-devtools-ui.md` §7.

View-only scrub is covered by `getDevToolsSnapshot` (0010). This ticket
adds the **actual rewind**: mutate the engine so a running (or finished)
workflow resumes from a past frame.

## Scope

### `jumpToFrame(runId, frameNo, confirm) → JumpResult`

```ts
type JumpResult = {
  ok: true;
  newFrameNo: number;
  revertedSandboxes: number;
  deletedFrames: number;
  deletedAttempts: number;
  invalidatedDiffs: number;
  durationMs: number;
};
```

Must reject with `ConfirmationRequired` if `confirm !== true`.

Orchestration (all-or-nothing; see §Rollback below):

1. Validate inputs.
2. Single-flight acquire lock for runId. If held → `Busy`.
3. Validate frameNo against latestFrameNo; resolve frame metadata.
4. Snapshot pre-jump state for rollback (see §Rollback).
5. Pause the run's event loop (if live).
6. For each affected sandbox: `revertToJjPointer(pointer, cwd)`.
7. Truncate `_smithers_frames` where frameNo > target.
8. Truncate `_smithers_attempts` rows started after target.
9. Truncate output rows created after target (per task output table).
10. Invalidate `_smithers_node_diffs` rows affected.
11. Rebuild reconciler state from target frame's XML.
12. Write audit row.
13. Emit `TimeTravelJumped` event.
14. Resume event loop.
15. Release lock.

### Rollback

If any step 4–11 fails partway:

- Restore reconciler from pre-jump snapshot.
- Re-seek JJ pointers back to pre-jump state (best-effort — log clearly
  if any sandbox cannot be restored; mark run status `needs_attention`).
- Surface `RewindFailed` with details of what was partial.

### `TimeTravelJumped` event

New entry in `SmithersEvent` union:

```ts
{ type: "TimeTravelJumped"; runId: string; fromFrameNo: number; toFrameNo: number; timestampMs: number; caller?: string }
```

Published to the event bus; `streamDevTools` subscribers receive this
and emit a full rebaseline snapshot.

### Audit log

New table `_smithers_time_travel_audit`:

```
id INTEGER PRIMARY KEY AUTOINCREMENT
runId TEXT NOT NULL
fromFrameNo INTEGER NOT NULL
toFrameNo INTEGER NOT NULL
caller TEXT NOT NULL         -- identity of the user/session
timestampMs INTEGER NOT NULL
result TEXT NOT NULL         -- "success" | "failed" | "partial"
durationMs INTEGER
```

Every call writes exactly one row, success or failure.

### Error codes

- `InvalidRunId`, `InvalidFrameNo`.
- `RunNotFound`, `FrameOutOfRange`.
- `ConfirmationRequired` — caller forgot `confirm: true`.
- `Busy` — another jumpToFrame in progress for this run.
- `UnsupportedSandbox` — some sandbox can't `revertToPointer`.
- `VcsError` — JJ revert failed.
- `RewindFailed` — post-rollback, partially completed.
- `RateLimited` — caller exceeded rewind quota.

### Rate limit

Max 10 rewinds per run per hour per caller. Exceeded → `RateLimited`.

## Files (expected)

- `packages/time-travel/src/jumpToFrame.ts` (new)
- `packages/time-travel/src/rewindLock.ts` (new — per-run single-flight)
- `packages/time-travel/src/rewindAudit.ts` (new)
- `packages/time-travel/src/rewindRateLimit.ts` (new)
- `packages/db/src/internal-schema/smithersTimeTravelAudit.ts` (new)
- `packages/db/migrations/XXXX_add_time_travel_audit.sql` (new)
- `packages/server/src/gatewayRoutes/jumpToFrame.ts` (new)
- `packages/server/src/gateway.ts` (register)
- `apps/observability/src/SmithersEvent.ts` (add event type)
- `packages/protocol/src/errors.ts` (extend)
- `packages/time-travel/tests/jumpToFrame.test.ts` (new)
- `packages/time-travel/tests/rewindLock.test.ts` (new)
- `packages/time-travel/tests/rewindRollback.test.ts` (new)
- `packages/time-travel/tests/jumpToFrame.integration.test.ts` (new)
- `packages/server/tests/jumpToFrame.auth.test.ts` (new)

## Testing & Validation

### Unit tests — lock

- Single caller acquires, releases; second caller proceeds.
- Two concurrent callers on same runId → second gets `Busy` without
  waiting.
- Two concurrent callers on different runIds → both proceed.
- Lock released on handler throw.
- Lock not released twice (idempotent release).

### Unit tests — truncation

- Frames > target deleted, frames ≤ target kept.
- Attempts started after target deleted.
- Output rows created after target deleted (per output table).
- Diff cache rows for post-target iterations invalidated.
- Audit row written.

### Unit tests — rollback

- Simulated failure at step 7 (frames truncation succeeds, attempts
  truncation throws) → full restore; reconciler matches pre-jump state.
- Failure to revert one sandbox of three → other two stay reverted, run
  marked `needs_attention`, audit row = `partial`, error =
  `RewindFailed`.
- Transient failure during rollback itself → logged, run marked
  `needs_attention`, clear error up the stack.

### Input-boundary tests

| Case                                    | Expected              |
|-----------------------------------------|----------------------|
| runId invalid                           | `InvalidRunId`       |
| frameNo = -1                            | `InvalidFrameNo`     |
| frameNo = latestFrameNo                 | no-op, success        |
| frameNo = latestFrameNo + 1             | `FrameOutOfRange`    |
| frameNo = 0                             | reverts fully         |
| run with no frames                      | `FrameOutOfRange`    |
| confirm = false / missing               | `ConfirmationRequired` |
| run that is currently completed         | un-completes + resumes |
| run with 3 sandboxes, one unsupported   | `UnsupportedSandbox`, no state change |
| 11th rewind in an hour                  | `RateLimited`         |
| concurrent second caller                | `Busy`                |

### Integration tests

- Run a 3-task sequence to completion. jumpToFrame to after task 1.
  Resume. Assert task 2 re-executes with original input; task 3
  executes on the new result.
- jumpToFrame to frame 0 → workflow restarts from scratch.
- jumpToFrame while a task is mid-execution → task cancelled cleanly,
  no zombie processes, VCS restored.
- Subscribe to `streamDevTools`, then jumpToFrame → subscriber receives
  `TimeTravelJumped`-triggered rebaseline snapshot.
- Audit row written in every case, including failure.

### Concurrency tests

- Two clients attempt jumpToFrame on the same run simultaneously →
  first succeeds, second gets `Busy`.
- jumpToFrame during an active `streamDevTools` with 5 subscribers →
  all 5 receive the rebaseline.
- jumpToFrame on runA while runB is also being rewound → both proceed
  independently.

### Chaos / resilience

- Kill the server mid-rewind (via test harness) → on restart, audit
  row shows `partial`, run marked `needs_attention`, no corrupted state.
- Simulate DB transaction deadlock → retried with backoff, either
  succeeds or returns clear error.

### Performance tests

- Small rewind (100 frames, 1 sandbox): < 2s.
- Large rewind (10,000 frames, 3 sandboxes): < 30s.
- Lock acquire: < 10ms.

## Observability

### Logs

- `info` on start: `{ runId, fromFrameNo, toFrameNo, caller }`.
- `info` on success: include all `JumpResult` fields.
- `warn` on partial rollback.
- `error` on `RewindFailed`, `VcsError`.
- `info` on audit row write (redundant with success but useful for
  grepping).

### Metrics

- Counter: `smithers_rewind_total{result=success|busy|failed|partial|rate_limited}`.
- Histogram: `smithers_rewind_duration_ms`.
- Histogram: `smithers_rewind_frames_deleted`.
- Histogram: `smithers_rewind_sandboxes_reverted`.
- Counter: `smithers_rewind_rollback_total`.

### Traces

- Span `timetravel.jumpToFrame` (root) with all input + output attrs.
- Child spans: `lock.acquire`, `snapshot.preJump`, `vcs.revert.{sandboxId}`,
  `db.truncate.frames`, `db.truncate.attempts`, `db.truncate.outputs`,
  `reconciler.replay`, `eventbus.emit`, `db.audit.insert`.

## Security

- Gateway auth required.
- Caller identity recorded in audit log.
- Authorization: only run owner (or admin) may rewind — enforced in
  handler, tested.
- Rate limit per caller per run.
- Input validation per §9.5.
- Never log sandbox file content.

## Acceptance

- [ ] All unit tests pass.
- [ ] All boundary cases return documented response.
- [ ] Integration tests drive real workflows with real sandboxes.
- [ ] Rollback test suite (simulated failures at every step) passes.
- [ ] Concurrency tests pass.
- [ ] Chaos tests pass.
- [ ] Performance budgets met.
- [ ] Audit row written on every call (success + failure).
- [ ] Rate limit enforced and tested.
- [ ] Logs + metrics + traces as documented.
- [ ] Every error code produced from its documented trigger.

## Blocked by

- smithers/0010 (`getDevToolsSnapshot` for post-jump rebaseline)

## Blocks

- smithers/0014 (CLI exposes via `smithers rewind`)
- gui/0081 (Time-travel scrubber + Rewind UI)
