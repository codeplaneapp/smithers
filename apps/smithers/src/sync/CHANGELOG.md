# apps/smithers sync glue changelog

## 0.3.0 — TanStack DB migration (2026-06-14)

### Changed

- The bespoke sync core (`SyncClient` / `SyncCache` / `SyncSubscriptionHub`) is
  replaced by TanStack DB collections. `packages/gateway-client` now ships
  `createGatewayCollection`, a collection-options-creator that initial-loads via
  `client.rpc(method, params)` and applies stream frames through the collection
  sync writer's `begin()`→`write()`→`commit()`. The existing gateway
  WebSocket+RPC transport (`SyncTransport` / `createSmithersGatewayTransport`)
  is unchanged.
- `packages/gateway-react` reimplements the sync hooks over
  `@tanstack/react-db` (`useLiveQuery`), keeping every public hook name and
  signature stable, and adds `useGatewayRunTree` (a devtools-snapshot live
  query) plus `useGatewayConnectionStatus`.
- `apps/smithers/src/sync/appSyncClient.ts` is replaced by
  `appGatewayCollections.ts`, which builds the `GatewayCollections` registry via
  `createGatewayCollections` over the instrumented `getGatewayClient()`
  transport (auth, CSRF, same-origin proxy, observability preserved). `main.tsx`
  passes that registry to `<SyncProvider>`.
- The hand-rolled `gatewayStore` (zustand) and its `bindGateway` bridge are
  deleted; consumers read from the gateway-react hooks. Node outputs
  (`getNodeOutput`) and diffs (`getNodeDiff`) stay fetched on-demand by id,
  never synced into a collection.

## 0.2.0 — slice C.1 (2026-06-07)

### Changed

- The declarative sync SDK moved into `packages/gateway-client` (core: keys,
  cache, subscription hub, transport, backoff, gatewayKeys) and
  `packages/gateway-react` (React surface: provider + hooks). Both are now
  reusable across embedded custom workflow UIs without dragging in apps/smithers.
- `apps/smithers/src/sync/` shrinks to a single file, `appSyncClient.ts`, which
  wires the gateway-client `SyncClient` to:
  - `gatewayRpc` for RPC (keeps cookie auth, CSRF, dev-proxy URLs)
  - `createSmithersGatewayTransport(SmithersGatewayClient)` for streams
    (resilient generators with reconnect + lastSeq resume)
- `main.tsx` imports `SyncProvider` from `@smithers-orchestrator/gateway-react`.

### Fixed

- `useSyncQuery` snapshots are now versioned. The cache mutates entry objects
  in place, so the previous `getSnapshot` returned a stable reference and
  React skipped re-renders for loading→success, refetch, invalidate, and
  cache.setData updates. A monotonic `version` counter on each entry, combined
  with a cached snapshot keyed by version, restores the expected react
  re-render on every notify-worthy change.
- `SyncSubscriptionHub` no longer treats a graceful iterable end as a drop.
  Resilient transports (`streamRunEventsResilient` returning on `run.completed`)
  now finalize the channel instead of looping forever. Transient drops (a
  thrown error from the iterable) still reconnect with backoff and resume from
  `afterSeq = lastSeq`. Raw transports that need the hub to reconnect on a
  silent socket close opt in via `reconnectOnGracefulEnd: true`.
- `appSyncClient` now provides a real streamFactory backed by
  `SmithersGatewayClient`, so `useGatewayRunStream` works against the live
  gateway (previously the SDK's stream hooks would throw).
- `handleAuthRequired` is now re-entrant-safe. Previously the RPC path
  (`gatewayRpc`) and the SyncClient `onAuthError` could both fire on the same
  UNAUTHORIZED failure, double-navigating to `/login`. The guard collapses the
  burst to a single redirect.
- `createSmithersGatewayTransport` captures its stream client once at
  construction; no fragile `options.streamFactory!` non-null-assertion inside a
  conditional spread.

### Tests

- Core sync invariants moved to `packages/gateway-client/tests/sync/*` (Bun).
- React hook lifecycle tests live in
  `packages/gateway-react/tests/sync/sync.test.ts` (happy-dom + React real
  reconciler): query loading→success, refetch, invalidate rerender,
  optimistic mutation rollback, subscription frames + consumer-side
  backpressure.
- Hub now has an explicit "graceful end is terminal" test and a
  `reconnectOnGracefulEnd: true` opt-in resume test alongside the existing
  transient-drop reconnect-with-afterSeq coverage.

## 0.1.0 — slice C (2026-06-07)

First cut of the declarative sync layer (in apps/smithers — superseded by
0.2.0). See `.smithers/specs/smithers-sync-sdk.md` for the design rationale.
