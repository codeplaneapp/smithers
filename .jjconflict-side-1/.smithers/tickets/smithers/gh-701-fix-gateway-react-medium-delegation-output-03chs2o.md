# 🐛 fix(gateway-react): [medium] delegation output re-fetch gated on a bounded event-ring finish count leaves transient getNodeOutput errors permanent

GitHub: https://github.com/smithersai/smithers/issues/701

_via ultracode (Opus multi-agent) review_

## Summary
In `useDelegationChain`'s store, output re-fetch is gated on a *finish count derived from the bounded live event ring* being compared against a *monotonic stored high-water mark*, so a transient `getNodeOutput` failure on a leaf that finished once is never retried for the rest of the session, and ring eviction can silently drop legit finish-driven re-fetches.

## Location
- `packages/gateway-react/src/delegation/delegationChainStore.ts:318` — `finishCounts = countFinishes(inputsNow.events)` where `inputsNow.events` is the bounded ring.
- `packages/gateway-react/src/delegation/delegationChainStore.ts:325-327` — skip unless `finishCount > entry.finishCount`.
- Ring is bounded at `packages/gateway-react/src/delegation/useDelegationChain.ts:53` (`useGatewayRunEvents(runId, { maxEvents: 1000 })`) → sliced to last 1000 non-heartbeat frames in `useGatewayRunEvents.ts:58`.

## Failure scenario (primary, no eviction needed)
1. Leaf `dc:foo:exec` finishes once → `finishCounts={dc:foo:exec: 1}`; reconcile schedules a fetch.
2. `api.getNodeOutput` hits a transient RPC error whose code is NOT in `EXPECTED_OUTPUT_ERRORS` (network blip / HTTP 500) → cache entry `{state:"error", finishCount:1}` (lines 286-287), surfaced as a `recordError`.
3. Every later reconcile still sees that same finish frame in the window, so `finishCounts.get(nodeId)` is still `1`; line 327 `entry.finishCount(1) >= finishCount(1)` → `continue`. The node never re-fetches.
4. A terminal leaf emits no further `node.finished`/`node.failed`, backfill runs once on mount (lines 394-425), the store is memoized on `runId` (useDelegationChain.ts:62), and there is no periodic reconcile — so the error is permanent for the whole session even though the output is durably available on the server.

## Secondary (long runs)
Because `finishCounts` comes from a sliding 1000-frame ring while `entry.finishCount` is a stored high-water mark, old finish frames get evicted over a long run and the windowed count can DROP below the stored count. A genuinely new finish (e.g. a retry within the same iteration that finally produces output) then fails the `finishCount > stored` test and never triggers a re-fetch, so the now-produced output is never displayed.

## Why it matters
This is the delegation-chain UI over a durable control plane. A single transient RPC blip permanently corrupts a node's displayed state with no in-session recovery, and ring eviction silently drops legitimate finish-driven re-fetches. Both violate the module's documented "exactly-once fetch with finish-event invalidation" contract (docstring lines 20-22; test `delegationChainStore.test.ts:209`).

## Suggested direction
Distinguish `error` from `missing` in the retry gate: transient (unexpected) errors should be retried independent of a finish-count increase (e.g. bounded backoff or re-fetch on any reconcile until produced), and finish-driven invalidation should key off a monotonic per-node finish marker that does not regress when the ring evicts old frames.
