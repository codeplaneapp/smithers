# [low] Paused run renders neutral "queued" tone in gateway run-node tree

GitHub: https://github.com/smithersai/smithers/issues/626

**Severity:** Low · **Feature:** graceful pause · **File:** `packages/gateway-client/src/sync/snapshotToGatewayRunNode.ts:139`

## Problem
`toRunStatus()` has no case for `'paused'`, so a paused run's derived state falls through to the `default` and renders as the neutral `'queued'` tone instead of a waiting/paused tone in the gateway run-node tree.

`deriveRunState` returns `state='paused'` for a paused run; `snapshotToGatewayRunNode` calls `toRunStatus('paused')` (`:211`), which matches none of the switch cases and returns `'queued'` (`:139`). The monitor UI tree then shows the paused run/root node with a neutral tone — inconsistent with `apps/cli/src/monitor-ui/monitorModel.ts`, which **was** correctly updated in the same slice to map `paused` → `waiting`/`attention`.

## Failure scenario
Pause a run → the gateway monitor run-node tree renders it with the same neutral tone as a queued run, giving no visual signal that it is paused.

## Suggested fix
Add `case "paused": return "waiting";` to `toRunStatus`. For completeness, `waiting-quota` is likewise unhandled and could be mapped.

## Verification
`deriveRunState` emits `paused` with no `blocked` field, so `blockedNodeId` is undefined and the root returns `runStatus="queued"`. The sibling `monitorModel.ts` mapping was patched for `paused` in this release but `toRunStatus` was missed. The `toRunStatus` mapping test (`snapshotToGatewayRunNode.test.ts:175-192`) also omits `paused`. Cosmetic tone only; run still loads and derives correctly.

---
*Found in the pre-0.28.0 review of `v0.27.0..HEAD` (@0ed2c28710), adversarially verified against the code. Part of the `pre-0.28-review` batch.*
