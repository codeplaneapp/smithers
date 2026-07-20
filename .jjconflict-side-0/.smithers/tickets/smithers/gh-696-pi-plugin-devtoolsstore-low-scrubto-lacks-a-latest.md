# 🐛 pi-plugin(DevToolsStore): [low] scrubTo lacks a latest-request guard, so overlapping frame scrubs settle on the wrong frame

GitHub: https://github.com/smithersai/smithers/issues/696

_via ultracode (Opus multi-agent) review_

## Summary
`DevToolsStore.scrubTo` has no request-generation token, so when two scrubs are in flight the last HTTP response to arrive wins regardless of which frame was requested last.

## Location
- `packages/pi-plugin/src/runtime/DevToolsStore.ts:372` — `scrubTo` awaits `client.getDevToolsSnapshot()` then unconditionally assigns `this.tree`/`this.seq`/`this.mode` (lines 388-390) with no check that this is still the latest request.
- `packages/pi-plugin/src/views/FrameScrubber.ts:8-24` — `handleInput` fires `void this.store.scrubTo(...)` per keypress without awaiting; next target is derived from `displayedFrameNo`, which `scrubTo` advances synchronously at line 385, so held/rapid arrows overlap requests.

## Failure scenario
User holds right-arrow. `scrubTo(5)` and `scrubTo(6)` dispatch. Gateway responds to frame 6 first (tree=frame6, mode=historical 6), then frame 5 (tree=frame5, mode=historical 5). Final state is frame 5 while the user's last action targeted 6 — the scrubber renders "frame 5" and the tree shows stale frame-5 state.

## Why it matters
Time-travel scrubbing intermittently shows a frame other than the one selected — misleading during debugging (the scrubber's whole purpose) and it corrupts the rewind action, which keys off `displayedFrameNo`.

## Fix
Capture a monotonically increasing request id in `scrubTo`; after the await, drop the snapshot if its id is not the latest before assigning to `tree`/`seq`/`mode`.
