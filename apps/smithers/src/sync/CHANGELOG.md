# apps/smithers sync glue changelog

## 0.4.0 — client SQLite persistence + pluggable SyncSource (2026-06-16)

Milestone 2 of `.smithers/specs/postgres-tanstack-sync.md` (phase 12.2). Warm
reload + offline reads, with no backend change yet.

### Added

- **Persistence wrapper.** `persistedCollectionOptions({ persistence,
  schemaVersion, maxRows, sanitizeRow })` (in `packages/gateway-react`) hydrates
  a collection from a durable cache before the first live frame and persists
  coalesced snapshots on commit. Wired into `createGatewayCollections` for every
  `persisted` collection def.
- **Platform persistence adapters** (subpath-only, never on the browser barrel):
  - `createBunSqlitePersistenceAdapter` — the real SQLite adapter (native
    Electrobun build); proven end-to-end in `tests/sync/*`.
  - `createOpfsJsonPersistenceAdapter` — the web durable cache (OPFS JSON).
    Honestly named: real SQLite-WASM/OPFS on the web is **deferred** (TanStack
    DB 0.6.8 ships no SQLite persistence contract; the OPFS SQLite VFS needs a
    cross-origin-isolated worker harness, out of scope here).
- **`schemaVersion` plumbing.** `gatewayClientSchemaVersion` is a local constant
  (the client's bundled schema head); bumping it clears the local copy and forces
  a cold re-sync. No `schema_signature` network RPC (that arrives in phase 3), so
  rehydration never blocks on a slow/offline gateway.
- **Pluggable `SyncSource` seam.** `selectAppSyncSource` chooses the source at
  boot from `backendStore` (gateway today; Electric in phase 7). Wired through a
  `createSource` factory so the chosen source gets the registry's per-collection
  status hooks.
- **Sync telemetry pipeline.** `bindSyncTelemetry()` binds the gateway-client
  telemetry seam to the structured logger (OTLP-shaped span lines, `otelSpan:
  true`) and `browserRegistry` (frame/error/gap/initial-load counters + a
  frame-lag histogram). Frames are metric-only; load/resync/error emit spans.

### Fixed

- **Error surfacing in the real app.** A pre-built `source` bypassed the
  registry's `onCollectionError`/`onCollectionReady` hooks, so collection load
  errors surfaced as silent success in the app (only the `client`-path test
  exercised it). The `createSource` factory now threads the status hooks through,
  closing the PR #286 edge on the boot path too.
- **One persistence adapter, shared.** The registry memoizes the resolved adapter
  so all collections share one instance; constructing a fresh adapter per
  collection let concurrent collections clobber each other's durable rows.
- **Large blobs stay out of persistence.** The `runEvents` collection sanitizes
  blob-bearing payloads (node outputs, transcripts, traces) on the way into the
  durable cache (`sanitizeRunEventRowForPersistence`); the live ring keeps full
  frames, the durable copy keeps a truncation marker. Outputs/diffs remain
  RPC-on-demand by id.
- **Event streams resume from the cached seq.** After a persisted `runEvents`
  collection rehydrates, the stream reopens with `afterSeq = max(cached seq)` so
  frames produced during the offline gap are replayed, not dropped.
- **Browser bundle.** The platform adapters are no longer re-exported from the
  `@smithers-orchestrator/gateway-react` barrel: re-exporting the bun:sqlite
  adapter pulled `import("bun:sqlite")` into every browser build and broke the
  custom workflow UI bundle (`Bun.build({ target: "browser" })` 500).

### Tests

- Real `bun:sqlite` round-trip (`tests/sync/bunSqlitePersistenceAdapter.test.ts`)
  and a through-the-stack warm-start + schemaVersion-clear over a real SQLite
  file. Run-event blob exclusion. Source parity over gateway **and** a fake
  Electric source for `useGatewayRuns/Run/Approvals/Workflows/RunTree`.
  Slow-consumer backpressure (producer never blocks; persists stay bounded).

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
