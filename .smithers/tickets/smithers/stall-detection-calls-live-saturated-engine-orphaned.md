# stall detection calls a live, saturated engine "orphaned" and suggests a split-brain force resume

**What happened (observed live, 2026-07-11 ~00:55Z, ticket-fleet run `run-1783727681742`)**
- The monitor emitted `run-stalled` ("no heartbeat for over 120s") and `smithers ps` showed `status: stale, unhealthy: engine-heartbeat-stale`.
- The driver was alive and healthy the whole time: `bun …/index.js up …/ticket-fleet.tsx --max-concurrency 64 --run-id run-1783727681742`, 55 CPU-minutes, 4.4 GB RSS, codex agents actively streaming `AgentEvent`s (53k+ events, ~1000/min at times).
- `smithers why` declared it "orphaned" and suggested the unblock verbatim: `smithers up … --run-id run-1783727681742 --resume true --force true`.

**Why it's wrong**
- With 64-way concurrency the engine's event loop saturates and the heartbeat writer misses its 120s budget, so a busy run is indistinguishable from a dead one to the current check. Earlier the same night `run-1783718580190` went "stale" at the same `triage-apply` step; a human plausibly read that as hung and cancelled a healthy run.
- The suggested remedy is dangerous: `--resume --force` against a live engine attaches a second engine to the same run (split-brain: duplicate task scheduling, double agent spend, racing writes to run state).

**Acceptance criteria**
- Heartbeats survive event-loop saturation: emit from a mechanism that cannot be starved by frame/agent-event processing (timer on a worker, a separate heartbeat fd/process, or priority scheduling), or scale `stalledAfterMs` with observed event throughput — a run that persisted an event in the last stall window is not stale.
- `smithers why` / stale classification verifies liveness before saying "orphaned": when the recorded driver PID (or lock) is alive, report "engine busy (heartbeat lagging Ns under load)" and do NOT suggest `--force` resume.
- Force resume refuses (or requires an extra explicit override) when the run's driver PID is still alive.
- Regression test: a run whose engine keeps persisting events but skips heartbeats past `stalledAfterMs` must not emit `run-stalled` nor classify as orphaned.

**Pointers**
- Stall watcher: `apps/cli/src/claude-mirror/runClaudeMonitor.js` (`trackStall`, `stalledAfterMs`); the `engine-heartbeat-stale` classification feeding `smithers ps`/`why`; the orphaned-run unblock string in `why`.
- Related: `.smithers/tickets/smithers/cancel-noop-run-stays-running-stall-alerts-repeat.md` (stall alerts on cancelled runs — same watcher, different false positive).
