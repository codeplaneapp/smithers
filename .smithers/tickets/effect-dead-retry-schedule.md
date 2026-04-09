# Wire retryPolicyToSchedule or remove dead code

## Problem

`src/utils/retry.ts` defines and exports `retryPolicyToSchedule()` (lines 9-27)
which correctly converts smithers retry policies to `Effect.Schedule`. However,
this function is **never called anywhere in the codebase**. The engine ignores it
and uses `computeRetryDelayMs()` — a hand-rolled recursive retry loop with
manual delay computation, jitter, and backoff (50 lines of code that reimplements
`Schedule.exponential + Schedule.jittered + Schedule.upTo`).

## Proposed solution

Either:
1. **Wire it in**: Replace `computeRetryDelayMs` in the engine and bridge retry
   paths with `Effect.retry(operation, retryPolicyToSchedule(policy))`. This
   would be ~5 lines replacing ~50.
2. **Remove it**: If the manual approach is intentional, delete the dead code.

Option 1 is strongly preferred. The `retryPolicyToSchedule` function already
handles fixed/linear/exponential with cap — it just needs to be called.

## Severity

**MAJOR** — Dead code that solves the exact problem the engine hand-rolls.

## Files

- `src/utils/retry.ts` (dead `retryPolicyToSchedule`)
- `src/engine/index.ts` (manual retry delay in scheduler)
- `src/effect/compute-task-bridge.ts` (retry delay calculation)
