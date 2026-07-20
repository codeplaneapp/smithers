# 🐛 pi-plugin(extension): [medium] reopening the Smithers inspector mounts on a dead, disconnected store

GitHub: https://github.com/smithersai/smithers/issues/717

_via ultracode (Opus multi-agent) review_

## Summary
`trackRun()` returns a cached run without re-connecting its `DevToolsStore`, but closing the inspector permanently disconnects that store. Every open of a run after the first is a frozen, action-dead UI.

## Verified code path
- `packages/pi-plugin/src/extension.ts:390-394` — `trackRun()` returns the existing `TrackedRun` as-is; `store.connect()` is only called on first creation (line 400), never on reuse.
- `packages/pi-plugin/src/extension.ts:422-429` — `openInspector` passes pi's `done` as `onClose`.
- pi host `showExtensionCustom` (`@mariozechner/pi-coding-agent/dist/modes/interactive/interactive-mode.js:1779-1796`) — the 4th factory arg `close` calls `component?.dispose?.()` (line 1790). RunInspector invokes `onClose()` on `q`/escape (`RunInspector.ts:58-60`).
- `packages/pi-plugin/src/views/RunInspector.ts:153-156` — `dispose()` calls `store.disconnect()`.
- `packages/pi-plugin/src/runtime/DevToolsStore.ts:300-310` — `disconnect()` sets `shouldReconnect=false`, aborts the stream, `connectionState='disconnected'`, and `runId=undefined`.
- `packages/pi-plugin/src/views/RunInspector.ts:41-54` — constructor only `store.subscribe(...)`; it never reconnects.

## Failure scenario
1. `/smithers <id>` (or `/smithers-watch <id>`): `trackRun` connects, inspector streams live.
2. User presses `q`/escape → pi's `close` → `RunInspector.dispose()` → `store.disconnect()` (stream aborted, `runId=undefined`). The `TrackedRun` stays cached in `runs`.
3. `/smithers <id>` again: `trackRun` returns the cached, disconnected store unchanged (extension.ts:391-394); a new `RunInspector` mounts on it.
4. Result: the tree is frozen at the last snapshot, no live deltas/heartbeats arrive, and action keys are silent no-ops — `selectedTask()` returns undefined on `!runId` so approve/deny do nothing (RunInspector.ts:166-169), `cancelRun()` bails on `!this.store.runId` (RunInspector.ts:207), and rewind/scrub hit `PI_RUN_NOT_FOUND`. No error is shown.

## Why it matters
The inspector is the plugin's core feature. It works exactly once per run per session; every subsequent open of the same run is a broken, frozen UI whose action keys do nothing, silently.

## Fix
Have `trackRun` re-arm a disconnected store before returning it (e.g. if `existing.store.runId === undefined` or `connectionState.kind === 'disconnected'`, call `existing.store.connect(runId)`) — the store is re-connectable (DevToolsStore tests exercise connect→disconnect→connect). Alternatively, make `dispose()` only unsubscribe rather than tear down the shared store.
