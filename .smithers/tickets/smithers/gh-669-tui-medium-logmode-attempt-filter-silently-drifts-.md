# 🐛 tui: [medium] LogMode attempt filter silently drifts to another attempt when the event ring evicts the oldest attempt

GitHub: https://github.com/smithersai/smithers/issues/669

_via ultracode (Opus multi-agent) review_

## Summary
The Logs view pins its per-attempt filter to a bare positional index into a list rebuilt from the sliding event window. When the oldest attempt's frames age out of the ring, every later index shifts left by one and the selection silently retargets a different attempt.

## Where
- `packages/tui/src/modes/LogMode.tsx:44` — `attemptIdx` is a raw positional index (not an attempt key).
- `packages/tui/src/modes/LogMode.tsx:46` — `attempts = extractAttemptKeys(events)`, order-of-first-appearance over the current window.
- `packages/tui/src/modes/LogMode.tsx:52-58` — clamp effect keyed on `attempts.length`, only handles tail-shrink (`prev > attempts.length - 1`); no front-eviction / key anchoring.
- `packages/tui/src/modes/LogMode.tsx:60-65,85-93` — `filteredEvents` and `attemptLabel` both derive from `attempts[attemptIdx]`.
- `packages/tui/src/modes/logUtils.ts:46-60` — `extractAttemptKeys` drops the leading key once that attempt's frames leave the window.
- `packages/gateway-react/src/useGatewayRunEvents.ts:58` — ring cap: `nonHeartbeat.slice(Math.max(0, nonHeartbeat.length - maxEvents))`; `TUI_EVENT_CAP = 2000` (`packages/tui/src/data.ts:38`, wired at `LogMode.tsx:24`).

## Failure scenario
On a long run in Logs mode the user presses `]` to filter to attempt index 2 (e.g. `nodeB:0`). The run keeps streaming; once total non-heartbeat events exceed 2000 and all of `nodeA`'s early frames evict from the front of the ring, `extractAttemptKeys` returns one fewer leading key. Index 2 now resolves to `nodeC:0`. The pane silently shows a different node's logs and the `attempt:` label changes, though the user never moved the selection. The tail-shrink clamp never fires.

## Why it matters
The filter is a stateful operator selection that should stay pinned to the chosen attempt. Silent drift makes the Logs tab misleading for exactly the long/chatty runs where per-attempt filtering is most useful. Fix: anchor the selection on the attempt key (as TreeMode's `resolveFocusIdx` anchors on `runNodeKey`) rather than a positional index, re-resolving the index from the stored key each render.
