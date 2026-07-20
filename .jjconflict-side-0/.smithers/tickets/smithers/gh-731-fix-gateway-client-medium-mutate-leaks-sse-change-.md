# 🐛 fix(gateway-client): [medium] mutate() leaks SSE change-stream when waitForSeq opens it with no subscribers

GitHub: https://github.com/smithersai/smithers/issues/731

_via ultracode (Opus multi-agent) review_

**Summary:** A mutation-only data client leaks a persistent `/v1/api/stream` SSE connection because `waitForSeq` opens the stream but nothing closes it once the waiter resolves.

**Where:** `packages/gateway-client/src/data/createSmithersDataClient.ts`
- `mutate` awaits `client.stream.waitForSeq(json.seq)` — line 360
- `waitForSeq` registers a waiter and calls `openStream()` — lines 445, 459-460
- `openStream` opens `source` because `waiters.size > 0` — line 266-277
- `emit` → `resolveWaiters` deletes/resolves the waiter but leaves `source` connected — lines 261-265, 252-260
- `source` is only closed by the `subscribe()` unsubscribe closure (line 428, guarded on empty listeners+waiters) or `close()` (line 466); `onerror` (line 285) only fires on transport error.

**Failure scenario:** A caller uses the client purely for mutations (e.g. `api.cancelRun`, `submitApproval`) and never calls `stream.subscribe`. The first mutation whose `seq > lastSeq` calls `waitForSeq`, which opens the SSE stream. Once the seq streams back the waiter is removed, but `source` stays non-null and connected; the `fetchEventSource` reader loop (line 208) keeps running, advancing `lastSeq` with no consumers, until `close()` is called. Also triggers for a subscribe→unsubscribe client that later mutates with a fresh seq.

**Why it matters:** `createSmithersDataClient` is a public export. Any mutation-only consumer (CLI helpers, single-action components) silently holds a long-lived SSE connection open on both client and server, wasting a server connection slot and a client reader loop with no observable benefit.

**Fix sketch:** After `waitForSeq` resolves (or in a `finally` around the `mutate` wait), if `streamListeners.size === 0 && waiters.size === 0` and the stream was opened solely to satisfy the waiter, close `source` and reset reconnect state — mirroring the unsubscribe closure at line 430-436.
