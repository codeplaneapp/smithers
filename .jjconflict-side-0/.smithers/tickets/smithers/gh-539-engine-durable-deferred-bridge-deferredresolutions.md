# 🐛 engine: durable-deferred-bridge `deferredResolutions` map is unbounded — resolutions for cancelled/abandoned runs leak in long-lived gateways

GitHub: https://github.com/smithersai/smithers/issues/539

**What happens**
`packages/engine/src/effect/durable-deferred-bridge.js:115` keeps a module-level `deferredResolutions` Map. `resolveBridgeDeferred` (line 136-138, via `bridgeApprovalResolve`/`bridgeWaitForEventResolve`) stores an Exit per execution id; the only deletion is in `awaitBridgeDeferred` (line 122-129) when the scheduler's next pass consumes it.

**Why it's wrong / failure scenario**
If a run is cancelled or abandoned after a resolution is stored but before the scheduler awaits it (approve-then-cancel, gateway serving many short-lived runs), the entry lives for the life of the process. A long-running gateway accumulates entries indefinitely. The sibling `activity-bridge.js` deliberately bounds its analogous module-level cache (`COMPLETED_ACTIVITY_RESULTS_MAX = 4096`, insertion-ordered LRU, comment citing long-running gateways at activity-bridge.js:17-57).

**Expected**
Same bounded-LRU treatment as activity-bridge, or explicit cleanup of a run's pending resolutions when the run reaches a terminal state.

Found during the 2026-07 repo-wide cleanup sweep (automated analyzer, human-unverified).
