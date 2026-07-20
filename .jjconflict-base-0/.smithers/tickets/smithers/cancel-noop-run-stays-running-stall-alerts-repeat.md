GitHub: https://github.com/smithersai/smithers/issues/939

# cancel reported for a run that never leaves `running`, so stall alerts keep re-firing

**What happened (observed live, 2026-07-10, ticket-fleet run `run-1783718580190`)**
1. 22:06Z — the Claude-plugin monitor task emitted `{"kind":"run-cancelled","runId":"run-1783718580190","summary":"Run … was cancelled."}`.
2. 22:35Z — the same monitor emitted `{"kind":"run-stalled", …"has not heartbeaten for over 120s"}` for the same run.
3. `smithers ps` at that moment: `status: stale, dbStatus: running, unhealthy: engine-heartbeat-stale, step: triage-apply`. `smithers why` calls it orphaned and suggests a `--resume --force`.

**Why it's wrong**
- A cancel that was accepted (a `run-cancelled` event reached the monitor stream) must eventually persist a terminal `cancelled` status; 30 minutes later the row still said `running`. Either the durable cancel signal was parked forever because the engine was already dead (no owner to process it), or the cancel path emitted the event before/without the DB transition.
- Whichever side is at fault, the stall watcher then treats the deliberately-cancelled run as orphaned and re-alerts every window, and its suggested action (force resume) would *undo* the human's cancel. Stall/orphan alerting should suppress runs with a pending or delivered cancel request, and `smithers why` should say "cancel requested but not yet applied — engine is dead; the resume will apply the cancel" (or the resume path should apply the parked cancel instead of continuing the run).

**Acceptance criteria**
- Cancelling a run whose engine/driver is already dead (no heartbeat) still converges to a terminal `cancelled` dbStatus without requiring a manual `--resume --force` — e.g. the cancel path detects a stale heartbeat and finalizes the row directly, or a supervisor applies parked cancels.
- The monitor/stall watcher never emits `run-stalled` (nor suggests resume) for a run that already produced `run-cancelled` / has a pending durable cancel.
- Integration test: kill a run's engine process, `smithers cancel <id>`, assert the run reaches `cancelled`, and assert no stall alert fires afterward.

**Pointers**
- Related: gh-884 (cascading cancellation and orphan reaping) covers descendants/process trees but not this monitor/status contradiction.
- Cancel path + durable cancel signals; the stall detection feeding the Claude-plugin monitor protocol (`smithers claude`), and `smithers why`'s orphaned-run branch.
