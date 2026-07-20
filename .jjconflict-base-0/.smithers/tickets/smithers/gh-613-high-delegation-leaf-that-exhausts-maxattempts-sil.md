# [high] Delegation leaf that exhausts maxAttempts silently hangs the run

GitHub: https://github.com/smithersai/smithers/issues/613

**Severity:** High · **Feature:** delegation-chain · **File:** `packages/components/src/components/delegation/DelegationExecution.js:202`

## Problem
A delegation leaf whose gates never pass within `maxAttempts` **silently hangs the entire run** instead of failing it.

The attempt `<Loop>` gives up with `onMaxReached:'return-last'`, which the scheduler marks **done** (not `Failed`) — but `leafComplete` / `executionComplete` still require `state.allPass`. So when a leaf's review/check/dev-preview gate returns `fail` (or `builtOk:false`) for all attempts:

1. `leafAttemptState.allPass` stays `false` → `leafComplete` (`delegationState.js:532`) returns `false` → `executionComplete` (`delegationState.js:616`) returns `false` **forever**.
2. `DelegationScoring` never mounts the poll, so no `dcPoll` row is written.
3. `DelegationEditListener.done` (`DelegationEditListener.js:33`) never becomes true → its armed `<Loop>`/`<Signal>` never unmounts.
4. The top-level `<Parallel>` in `DelegationChain.js:76` waits on the edit listener forever. The run wedges with **no error** (the `Aspects` latency SLO only fires if `budget.maxMinutes` is set, which the shipped seeded workflow leaves undefined).

## Why it matters
`delegation-chain` is a **seeded workflow installed by `smithers init`**, and the trigger — a leaf failing its gate for all `maxAttempts` (default 3) — is the ordinary "agent couldn't satisfy the gate" outcome, not an exotic edge. Detached/headless runs have no watcher; the run slot is consumed indefinitely with nothing surfaced.

## Failure scenario
A leaf's gate keeps returning `verdict:'fail'` for all 3 attempts. `leafAttemptState.allPass` stays false, `executionComplete` never returns true, and the run parks on the durable `dc-edit` signal wait with no error and no terminal state.

## Suggested fix
Make exhausted `maxAttempts` a terminal outcome for the leaf/run: either set `onMaxReached:'fail'` on the attempt loop (`DelegationExecution.js:198-204`), or have `executionComplete`/`leafComplete` treat a maxed-out leaf as terminally failed so the run can reach a terminal state.

## Verification
Full failure chain reproduced against current code: `makeWorkflowSession.js:832-841` marks a maxed-out ralph `{done:true}` not `Failed`; leaf gate failures are deliberately not turned into replan triggers (`delegationState.js:578`); `DelegationEditListener` stays armed; `DelegationChain.js:79` does not wrap in `Aspects` when `budget` is undefined. No test exercises the exhausted-attempts terminal path.

---
*Found in the pre-0.28.0 review of `v0.27.0..HEAD` (@0ed2c28710), adversarially verified against the code. Part of the `pre-0.28-review` batch.*
