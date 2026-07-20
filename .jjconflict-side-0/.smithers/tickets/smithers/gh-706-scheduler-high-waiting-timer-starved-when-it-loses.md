# ⏳ scheduler: [high] waiting-timer starved when it loses the collapsed WaitReason to an approval/event, so the run's status-keyed timer sweep never fires its deadline

GitHub: https://github.com/smithersai/smithers/issues/706

_via ultracode (Opus multi-agent) review_

## Summary
When a run holds a `waiting-timer` task alongside a `waiting-approval`/`waiting-event` task, the scheduler collapses the run to a single non-Timer `WaitReason`, the engine persists a single non-`waiting-timer` run status, and the gateway timer sweep (which filters purely by run status) never resumes the run — so a durable timer's deadline is silently never honored.

## Code path
- `packages/scheduler/src/makeWorkflowSession.js:105-121` — `findWaitingReason()` sets `primaryReason` to Approval (105) / Event (108) first; the Timer branch (114) is gated behind `!primaryReason`, so Timer is priority 3.
- `packages/scheduler/src/makeWorkflowSession.js:726-771` — the runnable loop mirrors it: a non-async approval sets `waitReason ??= {Approval}` (732) and event sets `{Event}` (741) before the Timer branch (768).
- `packages/engine/src/engine.js:5683-5710` — `handleDriverWait` switches on the single `_tag` and calls `markRunWaiting("waiting-approval")` (5555/5600/5606) or `"waiting-event"` (5643), persisting exactly one run status; the coexisting timer node stays `waiting-timer` but the RUN status is now `waiting-approval`/`waiting-event`.
- `packages/server/src/gateway.js:4401` — `listRuns(1_000, "waiting-timer")` pre-filters by run status. `runTimerDueAtMs` (4351-4361) already locates the pending timer node and its persisted fire time regardless of run status, but is never reached because the run is not listed.

## Failure scenario
A `<Parallel>` racing an approval / `<WaitForEvent>` (descriptor order 0) against a `<Timer duration="24h">` (the canonical "wait for human OR auto-proceed after N" pattern), optionally with a normal running task. While other work runs, the run stays `running`. When the last runnable task completes, `decide()` re-runs, nothing new is runnable, and `findWaitingReason()` returns the Approval/Event reason (order 0), re-parking the run as `waiting-approval`/`waiting-event`. The timer node is still `waiting-timer` with its fire time persisted, but `listRuns(..., "waiting-timer")` never returns the run. The 24h deadline passes with no wakeup — the timer fires only if/when the approval or event independently resolves, or never (if the human was relying on the timer to time them out). Order-dependent: only triggers when the approval/event descriptor precedes the timer.

## Why it matters
Breaks the common "race a wait against a deadline / auto-proceed" pattern and can deadlock a run forever. Silent and order-dependent (the run just sits past its deadline in `waiting-approval`/`waiting-event`), so it is hard to diagnose. The quota path was already special-cased against exactly this shadowing (`makeWorkflowSession.js:97-99`); Timer — whose only wakeup is the status-keyed sweep — was left unprotected. No scheduler test covers approval/event + timer coexistence.

## Fix direction
Make Timer win the collapsed `WaitReason` whenever a `waiting-timer` task coexists with an approval/event, OR have the sweep also consider `waiting-approval`/`waiting-event` runs that have a pending timer node (the durable fire time is already available via `runTimerDueAtMs`).
