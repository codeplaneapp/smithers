# 🐛 engine: [medium] signalRun stores correlationId un-normalized — durable crash-resume signal match misses

GitHub: https://github.com/smithersai/smithers/issues/673

_via ultracode (Opus multi-agent) review_

## Summary
`signalRun` stores a signal's `correlationId` raw, but every match path uses the trimmed/normalized form. Live delivery masks the mismatch; after a crash mid-wait, the durable resume query does an exact SQL match on the trimmed value and misses the raw stored row — a durably-persisted signal silently fails to wake a waiting run.

## References
- `packages/engine/src/signals.js:56` — stores `correlationId: options.correlationId ?? null` (no trim); insert writes it verbatim at `packages/db/src/adapter.js:2289-2290`.
- `packages/engine/src/effect/durable-deferred-bridge.js:223,238` — live path `bridgeSignalResolve` normalizes both sides (`normalizeCorrelationId`) and compares against the trimmed `snapshot.correlationId` → live delivery resolves fine, masking the bug.
- `packages/engine/src/effect/deferred-state-bridge.js:906-908` — resume path `syncWaitForEventDurableDeferredFromDb` queries `adapter.listSignals` with the trimmed `snapshot.correlationId`.
- `packages/db/src/adapter.js:2338` — `listSignals` does exact `correlation_id = ?`.
- `apps/cli/src/index.js:6591-6592` — `smithers signal --correlation` passes the value raw (unlike the gateway webhook path at `gateway.js:3710`, which normalizes).

## Failure scenario
1. A `WaitForEvent` node parks; its snapshot stores `correlationId` trimmed (e.g. `"pr-42"`, via `parseWaitForEventCorrelationId`).
2. A caller sends `smithers signal ... --correlation "pr-42 "` (trailing whitespace / any value differing from its trimmed form). The row is stored as `"pr-42 "`.
3. Live delivery works: `bridgeSignalResolve` normalizes both to `"pr-42"` and resolves the in-memory deferred.
4. The process crashes/restarts AFTER the signal row is durably written but BEFORE the node is finalized to `finished`.
5. On resume, `syncWaitForEventDurableDeferredFromDb` queries `listSignals` with `correlationId: "pr-42"`. The stored row's `correlation_id = "pr-42 "` fails the exact match → no signal returned; the in-memory deferred map is empty post-restart, so `awaitWaitForEventDurableDeferred` is Pending.
6. The node stays `waiting-event` and hangs until timeout — or forever if no timeout.

## Why it matters
An accepted, durably-persisted signal silently fails to wake a waiting run after a restart — defeating the entire point of a durable `WaitForEvent`. The live-path masking means any test that doesn't crash mid-wait passes.

## Fix
Normalize `correlationId` with `normalizeWaitForEventCorrelationId` in `signalRun` before storing (and in the returned/delivered value), so storage and every match/query path agree.
