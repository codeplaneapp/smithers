# apps/smithers sync SDK

The data-sync layer for the chat-first PWA. Custom workflow UIs and in-tree
features alike read gateway data through this SDK instead of hand-rolling
fetches, polls, and WebSocket plumbing.

## Why it exists

Before this slice, every gateway-aware feature wrote its own request loop:
`useEffect` → `gatewayRpc(...)` → `useState` → invalidate on mount changes →
maybe a `setInterval` for polling. Five features, five subtly different versions
of the same logic, five chances to miss a stale-response guard or a reconnect.

The SDK collapses that into one cache, one stream multiplexer, one set of
hooks. Custom workflow UIs embedded in `/gw/$key/$runId` get the same surface
the in-tree code gets, so a third-party UI does not re-implement the protocol.

## What it gives you

A `SyncClient` that owns:

- a `SyncCache` (typed keys, dedupe, ref counts, stale-data guard via
  generation counters, optimistic-mutation snapshots)
- a `SyncSubscriptionHub` (one upstream per key, ref-counted across N
  observers, lastSeq tracked on cache for resume, exponential backoff with
  full jitter on reconnect, bounded per-listener ring for backpressure)
- React hooks (`useSyncQuery`, `useSyncMutation`, `useSyncSubscription`) backed
  by `useSyncExternalStore` so React schedules them through its own concurrent
  machinery — no `useEffect`, no manual cleanup, no tearing
- typed gateway convenience (`useGatewayQuery`, `useGatewayMutation`,
  `useGatewayRunStream`, `gatewayKeys`)

## Why these primitives, not TanStack Query

TanStack Query handles HTTP request caching well. It does not natively model
ref-counted long-lived WebSocket subscriptions with lastSeq replay, and we
already ship the gateway protocol in `packages/gateway-client`. Layering a
purpose-built cache on top of that protocol is cheaper than warping TanStack
Query into something it is not, and ships smaller into the PWA bundle.

## The pieces

### Typed keys

```ts
type SyncKey = readonly [scope: string, ...args: unknown[]];
```

Scope first (usually the RPC method or a domain), arguments after. The
fingerprint canonicalizes object key order, drops `undefined` fields, and
preserves array order so positional args and structural params both work.

### Cache

```ts
const cache = new SyncCache({ cacheTimeMs: 5 * 60_000 });
const off = cache.subscribe(key, (entry) => render(entry));
await cache.fetch(key, fetcher);
cache.setData(key, optimistic);     // returns { previous, previousStatus }
cache.invalidate(prefix, refetch);  // marks stale, refetches active observers
cache.setLastSeq(key, seq);         // monotonic up-only
```

When an entry's observer count hits zero, it lingers for `cacheTimeMs` then
collects. A fresh subscribe cancels the pending GC, so a route remount does
not trigger an immediate refetch.

### Subscription hub

```ts
const off = hub.subscribe(key, "streamRunEvents", { runId }, (frame) => …);
```

First subscriber opens the upstream stream. Subsequent subscribers piggyback.
Each gets its own bounded ring buffer (default 1024); a listener that throws
has its missed frames parked on its ring. Last unsubscribe closes the upstream
and frees the channel.

On a silent close (WebSocket close code 1006, indistinguishable from "no
events for a while"), the hub treats the stream end as a drop and reconnects
with full-jitter exponential backoff, passing `afterSeq = lastSeq` so the
gateway replays only the missed frames.

An `UNAUTHORIZED` error short-circuits the loop and fires `onAuthError` — we
do not hammer the gateway with a token it just rejected.

### Mutations

```ts
const { mutate } = useSyncMutation(runner, {
  onMutate:  (vars, c) => c.cache.setData(targetKey, optimistic).previous,
  onError:   (_e, _v, prev, c) => c.cache.setData(targetKey, prev as T),
  onSuccess: () => undefined,
  invalidate: [["gateway:listRuns"]],
});
```

`onMutate` returns the rollback context. The SDK passes it to `onError` so
optimistic writes undo symmetrically. Successful mutations invalidate the
listed key prefixes, refetching active observers.

### React hooks

`useSyncQuery(key, fetcher, { staleTimeMs })` — `{ data, error, status,
isLoading, isRefreshing, refetch }`.

`useSyncMutation(runner, options)` — `{ mutate, mutateSafe, status, isLoading,
data, error, reset }`.

`useSyncSubscription(key, scope, params, { maxFrames })` — `{ frames, last,
dropped }`.

Gateway-typed shortcuts (`useGatewayQuery` / `useGatewayMutation` /
`useGatewayRunStream`) call into the same primitives with `gatewayKeys` as the
key namespace.

## Package layout (post-extraction)

The SDK lives in the two existing gateway packages so embedded workflow UIs
get the same surface in-tree code does without reaching into apps/smithers:

- `@smithers-orchestrator/gateway-client` — vanilla core: `SyncKey`,
  `SyncCache`, `SyncSubscriptionHub`, `SyncClient`, `SyncTransport`,
  `SyncBackoff`, `gatewayKeys`, and `createSmithersGatewayTransport` which
  wires `SmithersGatewayClient`'s resilient stream generators in.
- `@smithers-orchestrator/gateway-react` — React surface: `SyncProvider`,
  `useSyncClient`, `useSyncQuery`, `useSyncMutation`, `useSyncSubscription`,
  and the typed gateway shortcuts (`useGatewayQuery`, `useGatewayMutation`,
  `useGatewayRunStream`).

## Wiring for apps/smithers

`main.tsx` mounts a single `<SyncProvider client={appSyncClient}>` around the
router. `appSyncClient` (the only file left in `apps/smithers/src/sync/`) wires
RPC to `gatewayRpc` (cookie auth + dev-proxy URLs) and streams to
`createSmithersGatewayTransport(SmithersGatewayClient)`, with
`handleAuthRequired` as `onAuthError`. `handleAuthRequired` is re-entrancy
guarded so the gateway-side 401 redirect doesn't fire twice when the SDK also
escalates the same UNAUTHORIZED error.

Non-React subscribers (e.g. `bindGateway`) can import `appSyncClient` directly.

The existing `gatewayStore` is unchanged; the SDK is additive. Migration of
the existing store onto SDK primitives is out of scope for slice C.

## Wiring for custom workflow UIs

A workflow UI mounted at `/workflows/<key>` can either:

- import from `@smithers-orchestrator/gateway-react` (in-tree or embedded UIs)
- pass a `SyncTransport` of its own (third-party UIs that talk to their own
  RPC over postMessage to the host iframe)

`createSmithersGatewayTransport(SmithersGatewayClient)` plugs the gateway
client's `streamRunEventsResilient` / `streamDevTools` in as the live streamer.

## What the SDK does NOT do

- It does not replace `gatewayStore` (existing) or the existing custom-UI
  iframe shim. Slice C is additive.
- It does not implement Suspense data adapters. The hooks return loading
  states.
- It does not persist cache to localStorage / IndexedDB. Reload starts cold.

## Tests

Vanilla core unit tests live under
`packages/gateway-client/tests/sync/*` (Bun):

| Concern                       | File                              |
|-------------------------------|-----------------------------------|
| Key fingerprinting / prefix   | `SyncKey.test.ts`                 |
| Backoff curve                 | `SyncBackoff.test.ts`             |
| Cache invalidation + GC       | `SyncCache.test.ts`               |
| Stale-data guard              | `SyncCache.test.ts`               |
| Version bumps on every notify (React re-render) | `SyncCache.test.ts` |
| Mutation rollback + invalidate-on-success | `SyncClient.test.ts`  |
| Reconnect on transient drop w/ lastSeq | `SyncSubscriptionHub.test.ts` |
| Graceful end is terminal      | `SyncSubscriptionHub.test.ts`     |
| `reconnectOnGracefulEnd: true` opt-in | `SyncSubscriptionHub.test.ts` |
| Large event bursts / backpressure | `SyncSubscriptionHub.test.ts` |
| Auth-error escalation         | `SyncClient.test.ts`, `SyncSubscriptionHub.test.ts` |

React lifecycle tests live in
`packages/gateway-react/tests/sync/sync.test.ts` (happy-dom + real React
reconciler): query loading→success, refetch re-renders with fresh data,
`client.invalidate` re-renders subscribers, direct `cache.setData` re-renders,
optimistic mutation rollback, subscription frames, consumer-side bounded
buffer backpressure.

Run:

- `pnpm -C packages/gateway-client test`
- `pnpm -C packages/gateway-react test`
- `pnpm -C apps/smithers test:unit`
