# 🐛 fix(gateway-ui): [low] auto-select effect clobbers the just-launched run selection

GitHub: https://github.com/smithersai/smithers/issues/727

_via ultracode (Opus multi-agent) review_

**Summary:** In `SimpleWorkflowDashboard`, launching a run selects it, but the auto-select reconcile effect immediately overrides that selection with the previously-top run, so the dashboard focuses the wrong run.

**Location:** `packages/gateway-ui/src/SimpleWorkflowDashboard.tsx:59-64,70-72`

**Failure scenario (requires >=1 existing run):**
1. State: `selectedRunId=OLD` (=`runs[0]`), `selectedRunPresent=true`, `activeRunId=OLD`.
2. User clicks Start. `launchRun` resolves with `runId=NEW`; line 72 `setSelectedRunId(NEW)`. `launchRun` does no optimistic update (`gateway-react/src/useGatewayActions.ts:16`); `runs` only refreshes later via async live-sync.
3. Render: `runs` lacks NEW, so `selectedRunPresent` (line 59) computes `false`. Effect deps `[runs, selectedRunPresent]` changed → effect (line 63) fires `setSelectedRunId(runs[0])` = OLD.
4. Render: `selectedRunId=OLD`, present, effect no-ops.
5. SSE adds NEW to `runs`; `selectedRunId=OLD` is still present, so `!selectedRunPresent` stays false — the effect never re-selects NEW. `activeRunId` stays OLD forever.

**Why it matters:** The dashboard's primary interaction — launch a workflow and watch it — lands on an older run's Nodes/Events panels instead of the run the user just started. The explicit selection in `start()` is silently defeated by the reconcile effect. (First-ever run is unaffected: the `runs.length > 0` guard on line 63 is false, so NEW sticks.)

**Fix idea:** Guard the reconcile effect against a pending just-launched selection (e.g. skip re-selection while `selectedRunId` is set but not-yet-present), or optimistically insert the launched run into the collection.
