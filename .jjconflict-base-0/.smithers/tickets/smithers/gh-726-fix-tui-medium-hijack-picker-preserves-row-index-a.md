# 🐛 fix(tui): [medium] hijack picker preserves row index across candidate churn → hands off to the wrong node

GitHub: https://github.com/smithersai/smithers/issues/726

_via ultracode (Opus multi-agent) review_

**Summary:** In the hijack picker, the candidate list is recomputed on every live event frame while the selection is anchored by numeric index, so a completing node can shift the list under the operator's highlight and hand off to the wrong agent session.

**Refs:**
- `packages/tui/src/modes/HijackMode.tsx:193` — `const candidates = hijackCandidates(nodes, events)` recomputed unmemoized every render; HijackMode re-renders on every frame via `useRunEvents` (line 190).
- `packages/tui/src/modes/HijackMode.tsx:50` — `Selecting` rebuilds `selectOptions` (new array ref) each render.
- `packages/tui/src/modes/hijackUtils.ts:62-74` — a terminal event `delete`s the node from the insertion-ordered Map, so `new Set(activeAttempts.values())` shifts later candidates up.
- `packages/tui/node_modules/@opentui/core/index.js:11277` — `set options` preserves `selectedIndex` numerically (clamped), never re-anchoring to the selected item's value.
- `@opentui/react` reconciler `updateProperties` diffs props by reference, so a fresh options array re-invokes that setter every render.
- `packages/tui/src/modes/HijackMode.tsx:82` — `onSelect` resolves the node from the currently-highlighted option's value.

**Failure scenario:** Two+ nodes are live. The operator arrows down to highlight the second candidate and pauses before pressing Enter. Concurrently the first node completes and drops out of `hijackCandidates`, shifting the list up so the highlighted index now points at what was the third node. The operator presses Enter and `smithers hijack --target <nodeId>` is launched against the unintended node's agent session.

**Why it matters:** Hijack hands the real terminal to a specific agent session — a destructive-ish control. Handing off to the wrong node because the candidate set churned under a preserved index is a concrete, hard-to-notice mis-action. Fix by freezing/snapshotting the candidate list on entry to the `selecting` phase (or anchoring the selection by `runNodeKey` row key) while the picker is open.
