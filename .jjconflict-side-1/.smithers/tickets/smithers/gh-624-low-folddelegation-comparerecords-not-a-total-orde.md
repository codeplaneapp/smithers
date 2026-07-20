# [low] foldDelegation compareRecords not a total order for _approval markers

GitHub: https://github.com/smithersai/smithers/issues/624

**Severity:** Low · **Feature:** delegation flux store · **File:** `packages/gateway-react/src/delegation/foldDelegation.ts:168`

## Problem
`compareRecords` is not a total order for `_approval` markers. They carry no `row` and often no `seq`, so the final tiebreak (`stableStringify` of the undefined row) compares equal. Two `_approval` records for the same `(nodeId, iteration)` with different `pending` and no `seq` sort **equal** → JS's stable sort preserves input order → the last-wins `ApprovalMarked` flag (hence the node's awaiting-human status) depends on array order, violating the module's order-insensitive contract for that input class.

## Failure scenario
Call the exported `foldDelegation` with two `_approval` records for the same `(nodeId, iteration)`, different `pending`, no `seq` (a resolved+pending pair). Table priority, iteration, intrinsicSeq (0), seq (0), nodeId, and `stableStringify(undefined)` all tie → order-dependent result.

## Why low
Unreachable through the store: it only emits `pending:true` markers and `approvals.data` holds one row per node/iteration; the only in-tree resolved+pending pair carries distinct `seq`. Manifests only by calling the public `foldDelegation` export directly with a crafted seq-less pair. The output-record path is a proper total order.

## Suggested fix
Add `pending` (and/or a stable synthetic key) as a final tiebreak in `compareRecords` so `_approval` markers are totally ordered.

## Verification
Traced every tiebreak key to a tie for the described input; `[...records].sort()` is stable so input order leaks into `approvalByKey` last-wins. One-line fix closes it.

---
*Found in the pre-0.28.0 review of `v0.27.0..HEAD` (@0ed2c28710), adversarially verified against the code. Part of the `pre-0.28-review` batch.*
