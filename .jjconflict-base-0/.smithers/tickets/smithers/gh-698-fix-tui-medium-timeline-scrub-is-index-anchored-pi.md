# 🐛 fix(tui): [medium] Timeline scrub is index-anchored — pinned frame silently drifts as the event ring evicts

GitHub: https://github.com/smithersai/smithers/issues/698

_via ultracode (Opus multi-agent) review_

## Summary
`TimelineView` tracks the scrubbed frame as a raw array index into a live, bounded event ring, so the pinned frame silently advances forward as old rows evict — the operator inspects a different (later) run state than the one they selected, with no keypress.

## Location
- `packages/tui/src/modes/TimelineMode.tsx:158` — `const [selectedIdx, setSelectedIdx] = useState(-1)` (raw index)
- `packages/tui/src/modes/TimelineMode.tsx:160-168` — `safeIdx = Math.min(selectedIdx, events.length-1)`; `selectedEvent = events[safeIdx]`; `upToSeq = selectedEvent.seq` (TimelineMode.tsx:227)
- `packages/tui/src/modes/TimelineMode.tsx:182-187` — `k` handler decrements off stale `prev`
- Ring source: `packages/gateway-react/src/useGatewayRunEvents.ts:8,45,58` — `DEFAULT_COLLECTION_MAX_ROWS = 1024`, sorted by seq, "most recent rows retained"
- Precedent already fixed in TreeMode: `packages/tui/src/modes/TreeMode.tsx:510` (anchor by `runNodeKey`) and `packages/tui/src/modes/treeUtils.ts:67-73` (`resolveFocusIdx`)

## Failure scenario
1. A run emits enough events to fill the 1024-row `runEvents` ring and keeps streaming.
2. Operator opens Timeline, presses `k` to scrub back to frame ~300 to inspect node state at that point.
3. New events stream in; the ring evicts the oldest rows from the front. `events.length` stays ~capped, so `safeIdx` keeps the same numeric value, but `events[safeIdx]` now points at a newer, higher-`seq` row.
4. `SnapshotPanel`'s `upToSeq` (= `selectedEvent.seq`) advances forward, showing a later run state than the frame the operator pinned — no keypress, no indication.

Secondary: if `events` shrinks below `selectedIdx` (reconnect/rewind), the `k` handler computes `cur = prev < 0 ? events.length-1 : prev` on the stale huge `prev` and does `Math.max(0, cur-1)`, so `k` appears dead until pressed `(selectedIdx − length)` times.

## Why it matters
The Timeline exists to freeze on and inspect a historical frame while debugging a long-running run — exactly the case where the ring fills and eviction occurs. Silently sliding the inspected frame forward makes the trusted state wrong precisely when it's being trusted, and the stuck-`k` case makes navigation appear broken. TreeMode already solved this by anchoring selection on a stable key and re-deriving the index each render; TimelineView should likewise anchor the scrub on `seq` (re-deriving `safeIdx` via `findIndex(ev => ev.seq === anchorSeq)` with a clamped fallback) instead of a bare index.
