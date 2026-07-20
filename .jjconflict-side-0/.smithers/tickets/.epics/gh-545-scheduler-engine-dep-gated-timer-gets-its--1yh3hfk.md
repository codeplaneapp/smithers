# 🐛 scheduler/engine: dep-gated Timer gets its clock started early and can be force-finished before its dependencies complete

GitHub: https://github.com/smithersai/smithers/issues/545

**What happens**
Two cooperating defects:
1. Scheduler guard: `timerFired` (`packages/scheduler/src/makeWorkflowSession.js:966-985`) bails only `if (state.states.get(key) !== "waiting-timer" && !descriptor.meta?.__timer)` — so for any timer descriptor it proceeds to `markTaskFinished` regardless of state, including `pending` (dependencies unmet) and already-`finished` (output overwritten with a fresh `{ firedAtMs }`).
2. Engine reconcile: `reconcileTimerWait` (`packages/engine/src/engine.js:5083-5107`) iterates ALL non-terminal `__timer` tasks in the graph — including pending timers whose deps are unmet — and `resolveTimerTaskStateBridge` (deferred-state-bridge.js:575-650) creates the timer attempt on first sight, anchoring a duration timer's `firesAtMs` at that moment; when it elapses the engine calls `workflowSession.timerFired`, which the broad guard accepts.

**Failure scenario**
Workflow: `Timer T1 (2h)` → `agent A` → `Timer T2 (10m)` → `B`. The run parks on T1; the first reconcile pass creates T2's attempt with `firesAtMs = now + 10m` even though A hasn't run. Best case, T2's wait is measured from the wrong anchor (it fires immediately once dispatched after A). Worst case, a reconcile pass after T2's premature deadline force-finishes T2 while still `pending`, unblocking B before A ran — an ordering violation.

**Expected**
- `timerFired` completes only tasks actually in `waiting-timer` (tolerating at most the fire-before-park race for dispatched timers, not pending-with-unmet-deps or finished).
- `reconcileTimerWait` skips timer tasks whose dependencies are not yet satisfied so the bridge never anchors their clock early.

Related but distinct: #502 (duration deadline drift from decide() recomputation), #494 (parked-timer silent death on source change).

Found during the 2026-07 repo-wide cleanup sweep (automated analyzer, human-unverified).
