# 🐛 db(runState): [low] parseEventMeta reads keys the engine never writes, so blocked.correlationKey is always "" for wait-for-event runs

GitHub: https://github.com/smithersai/smithers/issues/689

_via ultracode (Opus multi-agent) review_

## Summary
`parseEventMeta` probes correlation keys that the engine's wait-for-event attempt meta never contains, so `RunStateView.blocked.correlationKey` is always `""` for every parked wait-for-event run.

## Where
- `packages/db/src/runState/parseEventMeta.js:10-13` — probes `parsed.event.correlationKey`, `parsed.correlationKey`, `parsed.event.eventName`.
- `packages/engine/src/effect/deferred-state-bridge.js:417-432` (`buildWaitForEventAttemptMeta`) — the sole writer of the `waiting-event` attempt's `meta_json`, emitting `{ kind: "wait-for-event", waitForEvent: { signalName, correlationId, ... } }`. Written at `deferred-state-bridge.js:960-974` (parking insert) and 788/825/872.
- `packages/db/src/runState/computeRunStateFromRow.js:100-104` (`loadPendingEvent`) falls back to `correlationKey: ""` when the parse returns null.
- Correct sibling parser already in-package: `packages/db/src/waitForEventAttempt.js:46` (`parseWaitForEventAttemptSnapshot`), used by `adapter.findRunsAwaitingEvent` (`adapter.js:3300`).

## Failure scenario
A run parks on `<WaitForEvent event="issue-42" correlationId="issue-42">`. The engine writes attempt `meta_json` = `{"kind":"wait-for-event","waitForEvent":{"signalName":"issue-42","correlationId":"issue-42",...}}`. `computeRunStateFromRow` → `loadPendingEvent` → `parseEventMeta` finds none of its three keys → returns null → `blocked = { kind: "event", nodeId, correlationKey: "" }`. `smithers why`, the Monitor, gateway `getRunState`, and the DevTools snapshot all report an empty correlation key.

## Why it matters
The blocked reason is the primary signal explaining why a run is parked. An always-empty `correlationKey` strips the one field a user needs to know which signal/correlation the run awaits, degrading observability for every wait-for-event run. Two parsers in the same package disagree on the same on-disk format.

## Note on tests
The existing db tests pass only because they seed a fabricated `{ event: { correlationKey } }` shape the engine never emits (`runState-computeRunState.test.js:168`, `cov-runstate.test.js:37-39,182`), so they validate the wrong format. Fix should route `loadPendingEvent` through `parseWaitForEventAttemptSnapshot` (using `correlationId`/`signalName`) and update the tests to the real engine shape.
