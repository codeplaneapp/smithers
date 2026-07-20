# 🐛 fix(gateway-react): [low] unstable filtered `rows` defeats useGatewayRunEvents memo, causing per-render delegation-store churn

GitHub: https://github.com/smithersai/smithers/issues/699

_via ultracode (Opus multi-agent) review_

**Summary:** `useGatewayRunEvents` builds `rows` with an unconditional `.filter()` and feeds it as a `useMemo` dependency, so the memo recomputes every render and returns a fresh `events` array each time — defeating the memoization and driving per-render work in `useDelegationChain`.

**Location:**
- `packages/gateway-react/src/useGatewayRunEvents.ts:52` — `const rows = ((live.data ?? []) as GatewayRunEventRow[]).filter(...)` allocates a new array every render (no `useMemo`).
- `packages/gateway-react/src/useGatewayRunEvents.ts:63` — `useMemo(..., [rows, afterSeq, maxEvents])`; the `rows` dep changes identity every render, so the memo never hits and `events` is a fresh reference each render.
- `packages/gateway-react/src/delegation/useDelegationChain.ts:82` — push effect depends on `events.events`; new identity every render re-fires `store.push({...})`.

**Failure scenario:** Mount any component using `useDelegationChain` (or `useGatewayRunEvents`) under a frequently re-rendering parent (timer/animation/hover state). With zero new run events, every parent render recomputes the events array and pushes a fresh `InputsChanged` batch into the delegation store, running `reconcile` → `countFinishes` + `delegationTargetsFromEvents` over the full event list (up to `maxEvents` = 1000 rows) each frame.

**Why it matters:** Quietly defeats a memo intended to bound work per event change, turning an idle delegation view into per-render store churn. The store's snapshot dedup (`foldMemo` + `publish` no-op) prevents a re-render storm but not the redundant reconcile/target-derivation CPU on every render.

**Fix:** Wrap `rows` in `useMemo` keyed on `[live.data, runId]` so the filtered array is stable when the underlying data is unchanged, restoring the downstream memo's referential stability.
