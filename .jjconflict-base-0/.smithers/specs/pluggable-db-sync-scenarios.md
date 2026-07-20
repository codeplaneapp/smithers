# Browser-SQLite / TanStack-DB Sync — All Scenarios

Design + test plan for making the browser-SQLite / TanStack-DB sync work in
EVERY scenario (local + cloud, every engine backend), with real-backend tests
proving each. Companion to `.smithers/specs/pluggable-db-sync-unification.md`
(the architecture decision) — this doc settles the compatibility matrix, names
the concrete code changes, and specifies the comprehensive test plan.

Authored by driving OpenAI Codex (GPT-5.5) over a code-survey of the sync
surface; every claim is cited `file:line` against repo source.

---

**Verdict**

The gateway WS/RPC sync is architected to be backend-agnostic, but today it is only exercised end-to-end against SQLite. For PGlite and Postgres, code-reading says the path should work because the gateway reads through `SmithersDb` and the Postgres dialect adapter, but the repo does not yet prove it through the browser/TanStack sync surface.

PGlite-local: should use gateway WS/RPC over `SmithersDb`, no Electric, expected to work by code, not tested end-to-end. PGlite-cloud: do not use PGlite as an Electric source; if “cloud” means multiplayer live replication through Electric, PGlite is not compatible today. Use gateway WS/RPC backed by PGlite only for non-Electric/local-style deployments, or real Postgres for Electric cloud.

**1. Compatibility Matrix**

| Engine × deployment | Sync backing | Electric | Browser TanStack live data | Wired/tested today |
|---|---:|---:|---|---|
| SQLite × local single-user | Gateway `SyncTransport` → `SmithersDb` | No | Yes, via RPC initial load + WS streams | Partly tested: real gateway/DB tests use SQLite, client collection tests use fakes |
| SQLite × cloud multiplayer | Gateway `SyncTransport` only | No | Correct for one gateway over one SQLite file; not a proper multiplayer/cloud backend | Not a target cloud cell |
| PGlite × local single-user | Gateway `SyncTransport` → `SmithersDb` with `dialect:"postgres"` | No | Should work | Gap: no real gateway/TanStack sync test |
| PGlite × cloud multiplayer | Gateway `SyncTransport`; no Electric source | No | Local-style gateway sync should work, but no Electric fan-out/logical replication | Gap; not a valid Electric-cloud cell |
| Postgres × local/single tenant | Gateway `SyncTransport` → `SmithersDb` with `dialect:"postgres"` | No | Should work | Gap: no real gateway/TanStack sync test |
| Postgres × cloud multiplayer | Gateway `SyncTransport` → server-side Electric `SyncBacking` over real Postgres | Yes, server-side only | Target architecture: yes | Gap: proxy has real Electric+PG test, but browser collection path is not closed |

Evidence: browser sync only sees `SyncTransport.rpc()`/`stream()` [SyncTransport.ts](/Users/williamcory/smithers/packages/gateway-client/src/sync/SyncTransport.ts:32), and `createGatewayCollection` loads by RPC then streams frames [createGatewayCollection.ts](/Users/williamcory/smithers/packages/gateway-client/src/sync/createGatewayCollection.ts:245), [createGatewayCollection.ts](/Users/williamcory/smithers/packages/gateway-client/src/sync/createGatewayCollection.ts:301). Gateway stream reads go through `adapter.getRun/getLastFrame/listFrames` [getDevToolsSnapshot.js](/Users/williamcory/smithers/packages/server/src/gatewayRoutes/getDevToolsSnapshot.js:385), [getDevToolsSnapshot.js](/Users/williamcory/smithers/packages/server/src/gatewayRoutes/getDevToolsSnapshot.js:392), and run-event bridge uses `adapter.listEventHistory` [gateway.js](/Users/williamcory/smithers/packages/server/src/gateway.js:2672). PGlite is opened as Postgres-wire and returns a `{ dialect:"postgres", connection }` descriptor [create.js](/Users/williamcory/smithers/packages/smithers/src/create.js:481), [create.js](/Users/williamcory/smithers/packages/smithers/src/create.js:506). The dialect layer rewrites `?` to `$n` [sql-message-storage.js](/Users/williamcory/smithers/packages/db/src/sql-message-storage.js:597), [dialect.js](/Users/williamcory/smithers/packages/db/src/dialect.js:44).

Current tests do not prove PGlite/Postgres sync: `createSmithers()` rejects those backends [create.js](/Users/williamcory/smithers/packages/smithers/src/create.js:350), server gateway/devtools tests construct `bun:sqlite` directly [getDevToolsSnapshot.test.tsx](/Users/williamcory/smithers/packages/server/tests/getDevToolsSnapshot.test.tsx:18), [streamDevTools.test.tsx](/Users/williamcory/smithers/packages/server/tests/streamDevTools.test.tsx:178), and client sync tests use fake transports or a hand-written server [createGatewayCollection.test.ts](/Users/williamcory/smithers/packages/gateway-client/tests/sync/createGatewayCollection.test.ts:11), [sync-real-transport.test.ts](/Users/williamcory/smithers/packages/gateway-react/tests/sync/sync-real-transport.test.ts:58). PGlite/Postgres are tested at DB boot/dialect only [db-postgres-dialect.test.js](/Users/williamcory/smithers/packages/db/tests/db-postgres-dialect.test.js:1), [openSmithersBackend.test.js](/Users/williamcory/smithers/packages/smithers/tests/openSmithersBackend.test.js:33).

**2. Target Architecture**

Use one browser protocol everywhere:

```txt
React hooks / custom .smithers UI
  -> createGatewayCollections()
  -> TanStack DB collections
  -> optional browser SQLite-WASM OPFS row cache
  -> SyncTransport rpc/stream
  -> SmithersGatewayClient
  -> Gateway RPC/WS
  -> SyncBacking
       local: SmithersDbBackedSync over SQLite/PGlite/Postgres
       cloud: ElectricBackedSync over real Postgres logical replication
```

The browser SQLite is a row cache, not the source of truth: SQLite-WASM is injected by the host [createSqliteWasmBackend.ts](/Users/williamcory/smithers/packages/gateway-react/src/sync/persistence/createSqliteWasmBackend.ts:4), OPFS SAHPool is opened when available [createSqliteWasmBackend.ts](/Users/williamcory/smithers/packages/gateway-react/src/sync/persistence/createSqliteWasmBackend.ts:97), rows live in `gateway_rows` [PersistentCollectionStore.ts](/Users/williamcory/smithers/packages/gateway-react/src/sync/persistence/PersistentCollectionStore.ts:75), and `withPersistence` hydrates then write-throughs without changing live sync [withPersistence.ts](/Users/williamcory/smithers/packages/gateway-react/src/sync/persistence/withPersistence.ts:5), [withPersistence.ts](/Users/williamcory/smithers/packages/gateway-react/src/sync/persistence/withPersistence.ts:88).

The only divergence is behind the gateway: the source-of-record feed. Local reads use existing `SmithersDb` RPC/stream routes. Cloud reads may tail Electric server-side and translate shape changes into the same `SyncStreamFrame` contract. This matches the unification spec: browser never chooses gateway vs Electric [pluggable-db-sync-unification.md](/Users/williamcory/smithers/.smithers/specs/pluggable-db-sync-unification.md:77), divergence lives in gateway `SyncBacking` [pluggable-db-sync-unification.md](/Users/williamcory/smithers/.smithers/specs/pluggable-db-sync-unification.md:89), and Electric must not be pursued everywhere because it needs real Postgres logical replication [pluggable-db-sync-unification.md](/Users/williamcory/smithers/.smithers/specs/pluggable-db-sync-unification.md:219). The older backend spec’s client-side Electric branch [pluggable-db-backends.md](/Users/williamcory/smithers/.smithers/specs/pluggable-db-backends.md:40), [pluggable-db-backends.md](/Users/williamcory/smithers/.smithers/specs/pluggable-db-backends.md:207) should be superseded.

**3. Code Changes**

Add a server-side sync backing seam under `packages/server/src/sync/`:

- `SyncBacking.ts`: `initialRows(def, params, auth)`, `stream(def, params, {afterSeq, signal, auth})`, returning existing row payloads / `SyncStreamFrame`s.
- `SmithersDbBackedSync.ts`: wraps today’s gateway RPC handlers and stream routes. It should call the same route code that already uses `adapterForWorkflow()` [gateway.js](/Users/williamcory/smithers/packages/server/src/gateway.js:3673), `getDevToolsSnapshotRoute()` [getDevToolsSnapshot.js](/Users/williamcory/smithers/packages/server/src/gatewayRoutes/getDevToolsSnapshot.js:382), and `streamDevToolsRoute()` [streamDevTools.js](/Users/williamcory/smithers/packages/server/src/gatewayRoutes/streamDevTools.js:213).
- `ElectricBackedSync.ts`: tails Electric from the gateway process, reusing proxy/catalog scoping. The current proxy already fronts `/v1/shape` [createSmithersElectricProxy.ts](/Users/williamcory/smithers/packages/electric-proxy/src/createSmithersElectricProxy.ts:712) and forwards to Electric [createSmithersElectricProxy.ts](/Users/williamcory/smithers/packages/electric-proxy/src/createSmithersElectricProxy.ts:660). Convert Electric `insert/update/delete`, `snapshot-end`, `must-refetch`, and replay gaps into gateway collection frames.

Change `packages/server/src/gateway.js` to route collection sync through `SyncBacking`; keep existing method names initially so `gatewayCollectionDefs` still call `listRuns`, `getRun`, `getDevToolsSnapshot`, `listMemoryFacts`, etc. [gatewayCollectionDefs.ts](/Users/williamcory/smithers/packages/gateway-client/src/sync/gatewayCollectionDefs.ts:80), [gatewayCollectionDefs.ts](/Users/williamcory/smithers/packages/gateway-client/src/sync/gatewayCollectionDefs.ts:107), [gatewayCollectionDefs.ts](/Users/williamcory/smithers/packages/gateway-client/src/sync/gatewayCollectionDefs.ts:142).

Collapse the client branch in `packages/gateway-react/src/sync/createGatewayCollections.ts`: remove `syncSource`/`electric` selection at [createGatewayCollections.ts](/Users/williamcory/smithers/packages/gateway-react/src/sync/createGatewayCollections.ts:204), remove `electricCollection()` usage [createGatewayCollections.ts](/Users/williamcory/smithers/packages/gateway-react/src/sync/createGatewayCollections.ts:349), and make `memoryFacts` always use `knownCollection()` [createGatewayCollections.ts](/Users/williamcory/smithers/packages/gateway-react/src/sync/createGatewayCollections.ts:489). Then deprecate or internalize `createElectricCollection`, whose browser dynamic import is the branch to remove [createElectricCollection.ts](/Users/williamcory/smithers/packages/gateway-client/src/sync/createElectricCollection.ts:149).

Extend `createSmithersGatewayTransport` only if needed for a generic collection stream scope. Today it supports `streamRunEvents` and `streamDevTools` [createSmithersGatewayTransport.ts](/Users/williamcory/smithers/packages/gateway-client/src/sync/createSmithersGatewayTransport.ts:16), [createSmithersGatewayTransport.ts](/Users/williamcory/smithers/packages/gateway-client/src/sync/createSmithersGatewayTransport.ts:41). A future `streamCollection` can carry Electric-backed deltas without exposing Electric to the browser.

Fix test/server boot paths to use `openSmithersBackend()` for non-SQLite, because `createSmithers()` intentionally rejects `pglite`/`postgres` [create.js](/Users/williamcory/smithers/packages/smithers/src/create.js:350). The CLI gateway already imports and calls `openSmithersBackend()` [index.js](/Users/williamcory/smithers/apps/cli/src/index.js:2203), but still computes a `smithers.db` path before opening [index.js](/Users/williamcory/smithers/apps/cli/src/index.js:2195); tests should pin this and avoid bogus path coupling for PGlite/Postgres.

**4. Test Plan**

Add a no-mocks sync harness shared by `packages/gateway-react/tests/sync` and `e2e/sync`:

- Boot engine with `openSmithersBackend({}, { backend:"sqlite" | "pglite", cwd })`; for real Postgres use `backend:"postgres", connectionString`.
- Register a real workflow with `Gateway`, listen on loopback, and create a real `SmithersGatewayClient` plus `createSmithersGatewayTransport`.
- Create real TanStack collections with `createGatewayCollections({ client: transport, persistence })`.
- For browser SQLite cache, use real SQLite-WASM in unit/integration like current persistence tests [persistence.test.ts](/Users/williamcory/smithers/packages/gateway-react/tests/sync/persistence.test.ts:1), and add browser reload coverage where Playwright is available outside CI. CI has no browsers per repo guidance, so default CI should prove the same persistence logic with SQLite-WASM Node build and real transport.

Required new tests:

- SQLite local end-to-end: real gateway + real SQLite engine + real TanStack collections for `runs`, `run`, `nodes`, `runEvents`, `memoryFacts`. Some server pieces exist, but no single test closes engine → Gateway → `SmithersGatewayClient` → TanStack collection.
- PGlite local end-to-end: same as SQLite, using `openSmithersBackend({ backend:"pglite" })`. This is the decisive PGlite test.
- Postgres gateway end-to-end: same harness with `SMITHERS_TEST_PG_URL`; default skip if no URL or run via Docker service.
- Out-of-process event bridge on PGlite/Postgres: persist events through adapter and assert `streamRunEvents` replays them, including the `payload_json` fallback [gateway.js](/Users/williamcory/smithers/packages/server/src/gateway.js:2682).
- Cloud Postgres+Electric end-to-end: reuse `deploy/electric/docker-compose.yml`, which provides Postgres with `wal_level=logical` [docker-compose.yml](/Users/williamcory/smithers/deploy/electric/docker-compose.yml:17), [docker-compose.yml](/Users/williamcory/smithers/deploy/electric/docker-compose.yml:24), and Electric [docker-compose.yml](/Users/williamcory/smithers/deploy/electric/docker-compose.yml:44). Existing real Electric test stops at proxy auth/scope [electric-proxy.integration.test.ts](/Users/williamcory/smithers/packages/electric-proxy/tests/electric-proxy.integration.test.ts:1), [electric-proxy.integration.test.ts](/Users/williamcory/smithers/packages/electric-proxy/tests/electric-proxy.integration.test.ts:33); new test must feed a real gateway `ElectricBackedSync` and real TanStack collection.
- No browser Electric dependency test: ensure `gateway-react` public path no longer imports `@electric-sql/client`; current direct browser import is at [createElectricCollection.ts](/Users/williamcory/smithers/packages/gateway-client/src/sync/createElectricCollection.ts:149).

CI gating:

- Default compute-only CI: SQLite local, PGlite local, SQLite-WASM persistence, no agents, no browsers.
- Optional Postgres CI: run with `SMITHERS_TEST_PG_URL` or a Postgres service.
- Optional Docker Electric CI: gated like existing `describe.skipIf(!dockerAvailable)` [electric-proxy.integration.test.ts](/Users/williamcory/smithers/packages/electric-proxy/tests/electric-proxy.integration.test.ts:33).
- Soak remains opt-in, like current `SMITHERS_E2E_SOAK=1` [case28-soak-live-stream-rss.test.ts](/Users/williamcory/smithers/e2e/faults/case28-soak-live-stream-rss.test.ts:22).

**5. Phased Plan**

1. Lock the contract: add `SyncBacking` and document one browser `SyncTransport`.
2. Wrap current gateway behavior as `SmithersDbBackedSync`; add SQLite and PGlite end-to-end TanStack tests.
3. Add Postgres gateway end-to-end tests using `openSmithersBackend`, not `createSmithers`.
4. Implement `ElectricBackedSync` behind gateway, reusing electric-proxy scoping and real Electric fixture.
5. Remove/deprecate client `syncSource:"electric"` and direct `createElectricCollection` from `gateway-react`.
6. Add cloud Docker E2E: real Postgres + Electric → gateway → real TanStack collection.
7. Update specs/docs so `pluggable-db-backends.md` no longer describes browser-selected Electric as the target.

Open questions:

- Should gateway tail Electric directly with `@electric-sql/client`, or consume an internal scoped proxy endpoint?
- What is the exact frame encoding for Electric snapshot boundaries and `must-refetch`?
- How much Electric fan-out should be centralized in gateway versus delegated to a sidecar?
- Keep `createElectricCollection` as an internal diagnostic primitive, or delete it after gateway-backed Electric is proven?
- If PGlite later supports Electric-compatible logical replication, should it become an experimental cloud backing or remain local-only until officially supported?
