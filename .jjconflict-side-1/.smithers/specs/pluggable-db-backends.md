# Pluggable Database Backends for Smithers

## 1. Goal & Non-Goals

### Goals

Smithers needs one coherent storage architecture where `sqlite`, `pglite`, and `postgres` are all real engine backends, not partial code paths.

The target behavior is:

1. A clean local install works with no prompt, socket DB, Postgres, Electric, or migration step:

   ```sh
   smithers init
   smithers workflow run create-workflow
   smithers ps
   smithers inspect <run>
   smithers output <run> <node>
   ```

   The local default is `sqlite`.

2. The same resolved backend flows through:

   - engine/write path;
   - CLI reads: `ps`, `inspect`, `output`, `chat`, `logs`, `events`, `scores`, cron/scheduler/devtools reads;
   - gateway/server;
   - eval, optimize, monitor, review, and secondary workflow-loading paths.

3. `sqlite`, `pglite`, and `postgres` remain first-class and explicitly selectable. `pglite` is useful for local Postgres-dialect testing. `postgres` is the server/cloud backend of record.

4. Fail-loud migration behavior remains, but only when Smithers would otherwise read/write the wrong physical store. A clean `sqlite` default workspace must never trip `SMITHERS_MIGRATION_REQUIRED`.

5. Sync source is decoupled from engine backend:

   - local/single-player: SQLite engine store plus gateway WS/RPC `SyncSource`;
   - cloud/multiplayer: real Postgres engine store plus Electric SQL `SyncSource`;
   - PGlite is never an Electric source.

6. Client/UI attachment is also transport-pluggable:

   - local default UI attaches through gateway RPC/WebSocket, with no Electric shape URL and no Electric client runtime;
   - cloud UI attaches selected collections to Electric shapes through the existing collection registry seam;
   - writes always flow through gateway actions/RPC, even in Electric read-side mode.

### Non-Goals

- Do not make PGlite an Electric SQL source. The sync spec explicitly says Electric source is always real Postgres and never PGlite because PGlite lacks the required logical replication source behavior ([.smithers/specs/postgres-tanstack-sync.md](/Users/williamcory/smithers/.smithers/specs/postgres-tanstack-sync.md:291), [.smithers/specs/postgres-tanstack-sync.md](/Users/williamcory/smithers/.smithers/specs/postgres-tanstack-sync.md:296)).
- Do not remove `createSmithers()`. It is the synchronous SQLite authoring API and currently fails loud if `pglite` or `postgres` is requested ([packages/smithers/src/create.js](/Users/williamcory/smithers/packages/smithers/src/create.js:342), [packages/smithers/src/create.js](/Users/williamcory/smithers/packages/smithers/src/create.js:350)).
- Do not silently migrate, delete, merge stores, or show empty state when run history exists elsewhere.
- Do not require Electric, Postgres, or PGlite for local UI liveliness. The gateway transport already works against any backend the engine writes because it reads through `SmithersDb` ([.smithers/specs/postgres-tanstack-sync.md](/Users/williamcory/smithers/.smithers/specs/postgres-tanstack-sync.md:150), [.smithers/specs/postgres-tanstack-sync.md](/Users/williamcory/smithers/.smithers/specs/postgres-tanstack-sync.md:154)).
- Do not branch per UI component on backend. Backend and sync-source selection must be resolved once and passed through the client attachment seam.

## 2. Target Architecture

### Current Verified State

The current repo has backend pluggability in some places, but not end to end:

- `resolveSmithersBackendChoice()` resolves explicit option → env → config → default, and currently defaults to `pglite` ([packages/smithers/src/resolveSmithersBackendChoice.js](/Users/williamcory/smithers/packages/smithers/src/resolveSmithersBackendChoice.js:143), [packages/smithers/src/resolveSmithersBackendChoice.js](/Users/williamcory/smithers/packages/smithers/src/resolveSmithersBackendChoice.js:167)).
- Its migration gate only probes SQLite and throws when the resolved backend is `pglite`/`postgres` and a SQLite store has runs ([packages/smithers/src/resolveSmithersBackendChoice.js](/Users/williamcory/smithers/packages/smithers/src/resolveSmithersBackendChoice.js:34), [packages/smithers/src/resolveSmithersBackendChoice.js](/Users/williamcory/smithers/packages/smithers/src/resolveSmithersBackendChoice.js:174)).
- `openSmithersBackend()` already returns the same Smithers API shape for `sqlite`, `postgres`, and `pglite` ([packages/smithers/src/openSmithersBackend.js](/Users/williamcory/smithers/packages/smithers/src/openSmithersBackend.js:17), [packages/smithers/src/openSmithersBackend.js](/Users/williamcory/smithers/packages/smithers/src/openSmithersBackend.js:27)).
- SQLite goes through `createSmithers()` and `bun:sqlite` ([packages/smithers/src/openSmithersBackend.js](/Users/williamcory/smithers/packages/smithers/src/openSmithersBackend.js:41), [packages/smithers/src/create.js](/Users/williamcory/smithers/packages/smithers/src/create.js:379)).
- Postgres and PGlite go through `createSmithersPostgres()`; PGlite starts a local socket server and pg client and exposes `close()` ([packages/smithers/src/create.js](/Users/williamcory/smithers/packages/smithers/src/create.js:481), [packages/smithers/src/create.js](/Users/williamcory/smithers/packages/smithers/src/create.js:486), [packages/smithers/src/create.js](/Users/williamcory/smithers/packages/smithers/src/create.js:546)).
- The CLI read helper is the keystone defect: `openSmithersDb()` always imports `bun:sqlite`, opens `new Database(dbPath)`, and returns a SQLite-backed `SmithersDb` ([apps/cli/src/find-db.js](/Users/williamcory/smithers/apps/cli/src/find-db.js:111), [apps/cli/src/find-db.js](/Users/williamcory/smithers/apps/cli/src/find-db.js:118)).
- `findAndOpenDb()` calls backend resolution only as a gate, discards the choice, waits for `smithers.db`, and opens SQLite anyway ([apps/cli/src/find-db.js](/Users/williamcory/smithers/apps/cli/src/find-db.js:139), [apps/cli/src/find-db.js](/Users/williamcory/smithers/apps/cli/src/find-db.js:149)).
- The engine uses `workflow.db`; it does no backend resolution itself ([packages/engine/src/engine.js](/Users/williamcory/smithers/packages/engine/src/engine.js:4833), [packages/engine/src/engine.js](/Users/williamcory/smithers/packages/engine/src/engine.js:4836)).
- `executeUpCommand()` only stamps `SMITHERS_BACKEND` before importing a workflow; the workflow factory decides what it opens ([apps/cli/src/index.js](/Users/williamcory/smithers/apps/cli/src/index.js:1851), [apps/cli/src/index.js](/Users/williamcory/smithers/apps/cli/src/index.js:1868)).
- Gateway still derives a presumptive `smithers.db` path before `openSmithersBackend()`, which is wrong for PGlite/Postgres workspaces ([apps/cli/src/index.js](/Users/williamcory/smithers/apps/cli/src/index.js:2167), [apps/cli/src/index.js](/Users/williamcory/smithers/apps/cli/src/index.js:2180)).

### Shared Contract

Move the durable-store open contract into `packages/smithers` and make `apps/cli` consume it everywhere:

```ts
type SmithersBackend = "sqlite" | "pglite" | "postgres";

type SmithersBackendChoice = {
  backend: SmithersBackend;
  source: "options" | "env" | "config" | "existing-store" | "marker" | "default";
  workspaceRoot: string;
  sqlite?: { dbPath: string; exists: boolean; runCount: number; schemaVersion?: string };
  pglite?: { dataDir: string; exists: boolean; initialized: boolean; runCount?: number; schemaVersion?: string };
  postgres?: { connectionString?: "set"; runCount?: number; schemaVersion?: string };
  migratedMarker: boolean;
};

async function resolveSmithersBackendChoice(opts): Promise<SmithersBackendChoice>;

async function openSmithersStore(opts): Promise<{
  choice: SmithersBackendChoice;
  adapter: SmithersDb;
  db: unknown;
  dbPath?: string;       // only meaningful for sqlite
  cleanup: () => Promise<void> | void;
}>;
```

Rules:

1. Resolve once per entrypoint.
2. Open exactly that backend.
3. For reads, do not provision a new store. Reads against an empty workspace keep returning `CLI_DB_NOT_FOUND`.
4. For writes, provision the resolved backend.
5. Return cleanup keyed by backend, not duck-typed off `db`.

`openSmithersStore()` can build on `openSmithersBackend({}, opts)` for write-capable opens, but it needs a read-only/no-provision mode for CLI reads so `ps` in an empty directory does not create `smithers.db` or `.smithers/pg`.

### Flow by Path

Run path:

- `executeUpCommand()` continues to propagate `--backend` to detached children ([apps/cli/src/index.js](/Users/williamcory/smithers/apps/cli/src/index.js:1822)).
- Before workflow import, it resolves backend and sets `SMITHERS_BACKEND` for compatibility.
- Default `sqlite` workflows authored with `createSmithers()` keep working and stay zero-socket.
- Workflows that intentionally support `pglite`/`postgres` use `await openSmithersBackend(...)`.
- Engine still uses `workflow.db`, matching the current engine contract ([packages/engine/src/engine.js](/Users/williamcory/smithers/packages/engine/src/engine.js:4833)).

Read path:

- Replace `findAndOpenDb()` internals with `openSmithersStore({ mode: "read" })`.
- Keep `findSmithersDb()` and `openSmithersDb()` only as explicit SQLite helpers and legacy tests.
- Reads do not currently have `--backend` options; for the initial design, read selection remains env/config/default. Tests for non-default read backends should use `SMITHERS_BACKEND=pglite|postgres`, matching existing test idiom ([apps/cli/tests/migrate-command.test.js](/Users/williamcory/smithers/apps/cli/tests/migrate-command.test.js:103)).

Gateway:

- Resolve workspace first from `.smithers/`, not from `smithers.db`.
- Open the workspace store through the shared opener. `dbPath` is passed only for SQLite.
- Gateway already has an explicit `--backend` option ([apps/cli/src/index.js](/Users/williamcory/smithers/apps/cli/src/index.js:1413)).
- Replace per-workflow `setupSqliteCleanup()` in the discovery loop with backend-aware cleanup ([apps/cli/src/index.js](/Users/williamcory/smithers/apps/cli/src/index.js:2189), [apps/cli/src/index.js](/Users/williamcory/smithers/apps/cli/src/index.js:2193)).

Eval/monitor/optimize/review:

- Any path that loads a workflow then calls `setupSqliteCleanup()` must use `registerWorkflowCleanup()`.
- Any path that reads store state through `findAndOpenDb()` inherits correctness once that helper is fixed.
- TUI is separate because it calls `findSmithersDb()` and `openSmithersDb()` directly ([apps/cli/src/tui.js](/Users/williamcory/smithers/apps/cli/src/tui.js:459), [apps/cli/src/tui.js](/Users/williamcory/smithers/apps/cli/src/tui.js:476)).
- Scheduler already centralizes through `findAndOpenDb()` ([apps/cli/src/scheduler.js](/Users/williamcory/smithers/apps/cli/src/scheduler.js:15), [apps/cli/src/scheduler.js](/Users/williamcory/smithers/apps/cli/src/scheduler.js:17)).

### Sync Source vs Engine Backend

The sync topology is parallel to, not identical with, the engine backend:

| Mode | Engine Store | Sync Source | Electric? |
| --- | --- | --- | --- |
| Local default | SQLite | Gateway WS/RPC direct source | No |
| Local Postgres-dialect testing | PGlite | Gateway WS/RPC direct source | No |
| Cloud/multiplayer | Real Postgres | Electric SQL shapes | Yes |

The existing spec already states the decisive point: local/self-host syncs over gateway transport, cloud syncs over Electric, and the gateway transport works against SQLite, PGlite, or Postgres because it reads through `SmithersDb` ([.smithers/specs/postgres-tanstack-sync.md](/Users/williamcory/smithers/.smithers/specs/postgres-tanstack-sync.md:150), [.smithers/specs/postgres-tanstack-sync.md](/Users/williamcory/smithers/.smithers/specs/postgres-tanstack-sync.md:154)). Electric is cloud-only and requires real Postgres logical replication ([.smithers/specs/postgres-tanstack-sync.md](/Users/williamcory/smithers/.smithers/specs/postgres-tanstack-sync.md:291), [.smithers/specs/postgres-tanstack-sync.md](/Users/williamcory/smithers/.smithers/specs/postgres-tanstack-sync.md:332)).

### Client Attachment

> **SUPERSEDED on the Electric question — see [`pluggable-db-sync-unification.md`](./pluggable-db-sync-unification.md).**
> Research (2026-06-25, primary-source verified) confirmed Electric's source *must* be a real Postgres with logical replication and PGlite cannot be an Electric source, so there is no "Electric everywhere" path. The decided architecture therefore makes Electric a **server-side `SyncBacking` inside the gateway**, not a client-selected source: the browser **always** speaks gateway RPC/WebSocket `SyncTransport` and never chooses `gateway` vs `electric`, never sees a `shapeUrl`, and never hits `/v1/shape`. The cloud gateway tails Electric internally and re-emits the *same* `SyncStreamFrame` deltas as the local `SmithersDb` backing. Disregard the client-side `syncSource: "electric"` / `boot.sync.shapeUrl` switch described below; treat the unification doc as authoritative for the sync layer. The rest of this section (the `SyncTransport` + `createGatewayCollections` consumer seam, writes-through-RPC, collection fingerprints) stays correct.

There is already a consumer-side seam for UI sync: `SyncTransport` plus `createGatewayCollections()`.

`SyncTransport` is the minimal interface the sync cache consumes: `rpc(method, params, opts)` plus an optional `stream(scope, params, opts)` that returns an async iterable of `SyncStreamFrame` ([packages/gateway-client/src/sync/SyncTransport.ts](/Users/williamcory/smithers/packages/gateway-client/src/sync/SyncTransport.ts:1), [packages/gateway-client/src/sync/SyncTransport.ts](/Users/williamcory/smithers/packages/gateway-client/src/sync/SyncTransport.ts:32)). It is deliberately transport-agnostic so tests can pass a stub, production can pass a `SmithersGatewayClient` adapter, and UI code does not need to know whether the data source is gateway RPC/WebSocket or Electric.

`SmithersGatewayClient` is the concrete gateway client. Its options are `baseUrl`, `token`, `headers`, `fetch`, and `WebSocket` ([packages/gateway-client/src/SmithersGatewayClientOptions.ts](/Users/williamcory/smithers/packages/gateway-client/src/SmithersGatewayClientOptions.ts:1)). The WebSocket connection is represented by `SmithersGatewayConnection`, which owns `readonly ws: WebSocket` and the request/event lifecycle ([packages/gateway-client/src/SmithersGatewayConnection.ts](/Users/williamcory/smithers/packages/gateway-client/src/SmithersGatewayConnection.ts:56)). `createSmithersGatewayTransport(client)` adapts that concrete client to `SyncTransport`: `rpc` calls `client.rpcRaw(...)`, and `stream` supports `"streamRunEvents"` and `"streamDevTools"` ([packages/gateway-client/src/sync/createSmithersGatewayTransport.ts](/Users/williamcory/smithers/packages/gateway-client/src/sync/createSmithersGatewayTransport.ts:33), [packages/gateway-client/src/sync/createSmithersGatewayTransport.ts](/Users/williamcory/smithers/packages/gateway-client/src/sync/createSmithersGatewayTransport.ts:42), [packages/gateway-client/src/sync/createSmithersGatewayTransport.ts](/Users/williamcory/smithers/packages/gateway-client/src/sync/createSmithersGatewayTransport.ts:69)).

`createGatewayCollections(options)` is the registry every live hook reads through. Its `syncSource?: "gateway" | "electric"` option is the client-side switch, and the documented default is `"gateway"` ([packages/gateway-react/src/sync/createGatewayCollections.ts](/Users/williamcory/smithers/packages/gateway-react/src/sync/createGatewayCollections.ts:48), [packages/gateway-react/src/sync/createGatewayCollections.ts](/Users/williamcory/smithers/packages/gateway-react/src/sync/createGatewayCollections.ts:84), [packages/gateway-react/src/sync/createGatewayCollections.ts](/Users/williamcory/smithers/packages/gateway-react/src/sync/createGatewayCollections.ts:196)). Electric is engaged only when both `syncSource === "electric"` and an `electric` config object is present; otherwise the registry falls back to the gateway path ([packages/gateway-react/src/sync/createGatewayCollections.ts](/Users/williamcory/smithers/packages/gateway-react/src/sync/createGatewayCollections.ts:204), [packages/gateway-react/src/sync/createGatewayCollections.ts](/Users/williamcory/smithers/packages/gateway-react/src/sync/createGatewayCollections.ts:209)). Per collection, the registry chooses `knownCollection(...)` or `electricCollection(...)` under the same `syncKeyFingerprint(...)`, so hooks such as `useGatewayMemoryFacts` do not change when the transport changes ([packages/gateway-react/src/sync/createGatewayCollections.ts](/Users/williamcory/smithers/packages/gateway-react/src/sync/createGatewayCollections.ts:298), [packages/gateway-react/src/sync/createGatewayCollections.ts](/Users/williamcory/smithers/packages/gateway-react/src/sync/createGatewayCollections.ts:349), [packages/gateway-react/src/sync/createGatewayCollections.ts](/Users/williamcory/smithers/packages/gateway-react/src/sync/createGatewayCollections.ts:489)).

#### Mode A: Local Default, SQLite Engine + Gateway WS/RPC, No Electric

This is the default client path. Local now defaults to SQLite, and `createGatewayCollections()` defaults `syncSource` to `"gateway"` ([packages/gateway-react/src/sync/createGatewayCollections.ts](/Users/williamcory/smithers/packages/gateway-react/src/sync/createGatewayCollections.ts:84)). `createGatewayReactRoot()` constructs a `SmithersGatewayClient`, wraps it with `createSmithersGatewayTransport(client)`, and mounts `createGatewayCollections({ client: ... })` without `syncSource` or `electric` ([packages/gateway-react/src/createGatewayReactRoot.ts](/Users/williamcory/smithers/packages/gateway-react/src/createGatewayReactRoot.ts:20), [packages/gateway-react/src/createGatewayReactRoot.ts](/Users/williamcory/smithers/packages/gateway-react/src/createGatewayReactRoot.ts:25)). That means a one-call custom UI is gateway-WS-direct by default.

The client connects to the `smithers gateway` HTTP+WebSocket server. The CLI imports `@smithers-orchestrator/server/gateway` and creates `new Gateway(...)` in the gateway command ([apps/cli/src/index.js](/Users/williamcory/smithers/apps/cli/src/index.js:2192), [apps/cli/src/index.js](/Users/williamcory/smithers/apps/cli/src/index.js:2195)). The gateway discovers and serves workflow UIs from `.smithers/ui/<id>.tsx` ([apps/cli/src/index.js](/Users/williamcory/smithers/apps/cli/src/index.js:2211)). The boot config carries endpoint paths: `GatewayUiBootConfig` includes `rpcPath`, `wsPath`, `mountPath`, `assetBasePath`, `kind`, and `workflowKey` ([packages/gateway-client/src/GatewayUiBootConfig.ts](/Users/williamcory/smithers/packages/gateway-client/src/GatewayUiBootConfig.ts:1)). The default operator UI calls RPC at `(boot.rpcPath ?? "/v1/rpc") + "/" + method` and opens WebSocket at `new URL(boot.wsPath ?? "/", window.location.href)` ([packages/server/src/gatewayUi/defaultOperatorUi.js](/Users/williamcory/smithers/packages/server/src/gatewayUi/defaultOperatorUi.js:482), [packages/server/src/gatewayUi/defaultOperatorUi.js](/Users/williamcory/smithers/packages/server/src/gatewayUi/defaultOperatorUi.js:495)).

Live updates off a SQLite-backed engine store flow through the same gateway registry:

- Pollable list collections call gateway RPC methods such as `listRuns`, `getRun`, `listApprovals`, `cronList`, `listMemoryFacts`, `listScores`, `listTickets`, and `listWorkflows` ([packages/gateway-client/src/sync/gatewayCollectionDefs.ts](/Users/williamcory/smithers/packages/gateway-client/src/sync/gatewayCollectionDefs.ts:83), [packages/gateway-client/src/sync/gatewayCollectionDefs.ts](/Users/williamcory/smithers/packages/gateway-client/src/sync/gatewayCollectionDefs.ts:90), [packages/gateway-client/src/sync/gatewayCollectionDefs.ts](/Users/williamcory/smithers/packages/gateway-client/src/sync/gatewayCollectionDefs.ts:97), [packages/gateway-client/src/sync/gatewayCollectionDefs.ts](/Users/williamcory/smithers/packages/gateway-client/src/sync/gatewayCollectionDefs.ts:130), [packages/gateway-client/src/sync/gatewayCollectionDefs.ts](/Users/williamcory/smithers/packages/gateway-client/src/sync/gatewayCollectionDefs.ts:137), [packages/gateway-client/src/sync/gatewayCollectionDefs.ts](/Users/williamcory/smithers/packages/gateway-client/src/sync/gatewayCollectionDefs.ts:144), [packages/gateway-client/src/sync/gatewayCollectionDefs.ts](/Users/williamcory/smithers/packages/gateway-client/src/sync/gatewayCollectionDefs.ts:155), [packages/gateway-client/src/sync/gatewayCollectionDefs.ts](/Users/williamcory/smithers/packages/gateway-client/src/sync/gatewayCollectionDefs.ts:167), [packages/gateway-client/src/sync/gatewayCollectionDefs.ts](/Users/williamcory/smithers/packages/gateway-client/src/sync/gatewayCollectionDefs.ts:180)).
- Pollable collections re-pull through the in-process `INVALIDATE_SCOPE` pseudo-stream, not through Electric ([packages/gateway-react/src/sync/createGatewayCollections.ts](/Users/williamcory/smithers/packages/gateway-react/src/sync/createGatewayCollections.ts:95), [packages/gateway-react/src/sync/createGatewayCollections.ts](/Users/williamcory/smithers/packages/gateway-react/src/sync/createGatewayCollections.ts:233), [packages/gateway-react/src/sync/createGatewayCollections.ts](/Users/williamcory/smithers/packages/gateway-react/src/sync/createGatewayCollections.ts:317)).
- Per-run live data streams over the gateway WebSocket scope `"streamRunEvents"` ([packages/gateway-client/src/sync/gatewayCollectionDefs.ts](/Users/williamcory/smithers/packages/gateway-client/src/sync/gatewayCollectionDefs.ts:102), [packages/gateway-client/src/sync/gatewayCollectionDefs.ts](/Users/williamcory/smithers/packages/gateway-client/src/sync/gatewayCollectionDefs.ts:192), [packages/gateway-client/src/sync/createSmithersGatewayTransport.ts](/Users/williamcory/smithers/packages/gateway-client/src/sync/createSmithersGatewayTransport.ts:42)).

The gateway reads through `SmithersDb`, so this works against any engine backend the engine wrote: SQLite, PGlite, or Postgres. Local SQLite does not require Postgres or Electric on the client.

What `gateway-client` does not need in local mode:

- no Electric shape URL;
- no `electric` config object;
- no Electric source selection;
- no eager `@electric-sql/client` runtime. The Electric `ShapeStream` is behind a dynamic import, so a gateway-only bundle does not pull it ([packages/gateway-client/src/sync/createElectricCollection.ts](/Users/williamcory/smithers/packages/gateway-client/src/sync/createElectricCollection.ts:133), [packages/gateway-client/src/sync/createElectricCollection.ts](/Users/williamcory/smithers/packages/gateway-client/src/sync/createElectricCollection.ts:135)).

#### Mode B: Cloud/Multiplayer, Postgres Engine + Electric SQL

Cloud mode uses the same UI, hooks, and registry. The caller passes `syncSource: "electric"` plus `electric: { shapeUrl }` into `createGatewayCollections()`. `ElectricCollectionConfig.shapeUrl` is the absolute Electric shape endpoint, because `ShapeStream` constructs `new URL(url)` ([packages/gateway-client/src/sync/createElectricCollection.ts](/Users/williamcory/smithers/packages/gateway-client/src/sync/createElectricCollection.ts:74), [packages/gateway-client/src/sync/createElectricCollection.ts](/Users/williamcory/smithers/packages/gateway-client/src/sync/createElectricCollection.ts:76), [packages/gateway-client/src/sync/createElectricCollection.ts](/Users/williamcory/smithers/packages/gateway-client/src/sync/createElectricCollection.ts:312)).

Electric-dependent pieces plug in through the collection registry, not through ad hoc UI branches:

- `createElectricCollection()` opens a shape with `GET /v1/shape?table=...` for snapshot and live long-poll behavior; the `ShapeStream` runtime is dynamically imported ([packages/gateway-client/src/sync/createElectricCollection.ts](/Users/williamcory/smithers/packages/gateway-client/src/sync/createElectricCollection.ts:9), [packages/gateway-client/src/sync/createElectricCollection.ts](/Users/williamcory/smithers/packages/gateway-client/src/sync/createElectricCollection.ts:24), [packages/gateway-client/src/sync/createElectricCollection.ts](/Users/williamcory/smithers/packages/gateway-client/src/sync/createElectricCollection.ts:133), [packages/gateway-client/src/sync/createElectricCollection.ts](/Users/williamcory/smithers/packages/gateway-client/src/sync/createElectricCollection.ts:309)).
- `electricCollectionDefs.memoryFacts` is the current Electric twin. It maps `_smithers_memory_facts` and uses a parameterized server-side `where` when namespace filtering is present ([packages/gateway-client/src/sync/electricCollectionDefs.ts](/Users/williamcory/smithers/packages/gateway-client/src/sync/electricCollectionDefs.ts:89), [packages/gateway-client/src/sync/electricCollectionDefs.ts](/Users/williamcory/smithers/packages/gateway-client/src/sync/electricCollectionDefs.ts:97)).
- The server/proxy shape catalog enumerates run-scoped `_smithers_*` shapes and explicit output-table allowlist entries. It is not a regex catch-all ([packages/electric-proxy/src/smithersElectricShapeCatalog.ts](/Users/williamcory/smithers/packages/electric-proxy/src/smithersElectricShapeCatalog.ts:15), [packages/electric-proxy/src/smithersElectricShapeCatalog.ts](/Users/williamcory/smithers/packages/electric-proxy/src/smithersElectricShapeCatalog.ts:80), [packages/electric-proxy/src/smithersElectricShapeCatalog.ts](/Users/williamcory/smithers/packages/electric-proxy/src/smithersElectricShapeCatalog.ts:96)).
- The Electric proxy implementation lives in `createSmithersElectricProxy.ts` and `serveSmithersElectricProxy.ts`, which should remain the auth/scoping front for shape reads.

`gateway-client`/`gateway-react` switch to Electric by swapping the per-collection builder from `knownCollection(...)` to `electricCollection(...)` under the same collection fingerprint. The consumer hook remains unchanged ([packages/gateway-react/src/sync/createGatewayCollections.ts](/Users/williamcory/smithers/packages/gateway-react/src/sync/createGatewayCollections.ts:349), [packages/gateway-react/src/sync/createGatewayCollections.ts](/Users/williamcory/smithers/packages/gateway-react/src/sync/createGatewayCollections.ts:489)).

Writes still flow through gateway actions/RPC. Electric shapes are read-side only. The Electric collection builder wires no write/mutation path; mutation hooks call gateway RPC through the sync/gateway transport surface. This preserves server-side validation, auth, task/action semantics, and auditability. PGlite is never an Electric source.

#### The Switch

The client should decide its sync mode from one source of truth, not from component-local branching.

The concrete seam is:

```ts
createGatewayCollections({
  client: createSmithersGatewayTransport(gatewayClient),
  syncSource: boot.sync?.source ?? "gateway",
  electric: boot.sync?.source === "electric" ? { shapeUrl: boot.sync.shapeUrl } : undefined,
});
```

Recommended implementation:

- extend `GatewayUiBootConfig` with an optional server capability, for example:

  ```ts
  sync?: {
    source: "gateway" | "electric";
    shapeUrl?: string;
  };
  ```

- local gateway omits it or sets `{ source: "gateway" }`;
- cloud gateway sets `{ source: "electric", shapeUrl: "<absolute shape proxy url>" }`;
- `createGatewayReactRoot()` can remain gateway-default for local/simple custom UIs, while cloud shells or a future boot-aware root pass the server-provided sync config.

This makes adding/removing Electric a transport/config swap. App code, `.smithers/ui/*.tsx`, and the `gateway-react` live hooks should not branch on SQLite/PGlite/Postgres. (Note: `packages/components` is the workflow-authoring JSX library — `<Task>`, `<Approval>`, `<Saga>`, etc. — consumed by the reconciler/engine to *define* workflows; it imports no gateway/sync code and is unrelated to this seam.)

#### `smithers ui` and Component Entrypoints

`packages/gateway-react/src/index.ts` exports `createGatewayReactRoot`, `SmithersGatewayProvider`, `SyncProvider`, and the live hooks such as `useGatewayRun` and `useGatewayRuns` ([packages/gateway-react/src/index.ts](/Users/williamcory/smithers/packages/gateway-react/src/index.ts:1), [packages/gateway-react/src/index.ts](/Users/williamcory/smithers/packages/gateway-react/src/index.ts:3), [packages/gateway-react/src/index.ts](/Users/williamcory/smithers/packages/gateway-react/src/index.ts:13), [packages/gateway-react/src/index.ts](/Users/williamcory/smithers/packages/gateway-react/src/index.ts:15), [packages/gateway-react/src/index.ts](/Users/williamcory/smithers/packages/gateway-react/src/index.ts:29)). These are the surfaces the `.smithers/ui/*.tsx` custom UIs consume (22 of them import `createGatewayReactRoot` + `useGateway*`); `packages/components` is unrelated (it is the workflow-authoring JSX library, not a live-data view layer).

`createGatewayReactRoot()` mounts both `SmithersGatewayProvider` for on-demand hooks/actions/node output/extensions and `SyncProvider` for live collection hooks, giving custom workflow UIs the full surface from one call ([packages/gateway-react/src/createGatewayReactRoot.ts](/Users/williamcory/smithers/packages/gateway-react/src/createGatewayReactRoot.ts:20), [packages/gateway-react/src/createGatewayReactRoot.ts](/Users/williamcory/smithers/packages/gateway-react/src/createGatewayReactRoot.ts:33)).

#### Implication of the SQLite Default

Because local now defaults to SQLite and `syncSource` defaults to `"gateway"`, the default client path is gateway-WS-direct with no Electric. Existing or future client code that assumes Electric/Postgres must be made transport-agnostic:

- keep `@electric-sql/client` behind the dynamic import in `createElectricCollection()`;
- ensure any `createGatewayCollections()` caller defaults to `"gateway"` and only selects `"electric"` from an explicit cloud signal;
- derive cloud Electric config from server boot capability, build config, or connection URL once, then pass it into the registry;
- never require an Electric shape URL for local `smithers gateway` or `smithers ui`.

## 3. Default-Backend Policy

### Decision: SQLite Default Everywhere Local

Change the resolver default from `pglite` to `sqlite` ([packages/smithers/src/resolveSmithersBackendChoice.js](/Users/williamcory/smithers/packages/smithers/src/resolveSmithersBackendChoice.js:167)).

Also change `openSmithersBackend()`’s programmatic fresh-workspace default to SQLite. A single default is simpler and safer than “CLI default SQLite, library default PGlite,” because `openSmithersBackend()` is the canonical backend-aware API and many workflows/import sites use it directly ([packages/smithers/src/openSmithersBackend.js](/Users/williamcory/smithers/packages/smithers/src/openSmithersBackend.js:27)).

This intentionally changes the current test contract that “fresh workspaces default to persisted PGlite” ([packages/smithers/tests/openSmithersBackend.test.js](/Users/williamcory/smithers/packages/smithers/tests/openSmithersBackend.test.js:33)). Replace it with:

- default fresh workspace opens SQLite;
- explicit `backend: "pglite"` opens `.smithers/pg`;
- explicit env/config `pglite` still works.

Rationale:

- SQLite is the lightest local backend: no socket server, no pg client, no free-port selection, no extra process-like lifecycle.
- It aligns with the curated seeded workflows, which use `createSmithers()` for
  their local SQLite-backed graphs.
- It removes the clean-init migration failure class on the common path: seeded `createSmithers()` writes SQLite, and reads default to SQLite.
- It keeps the local live UI path simple because gateway sync already reads through `SmithersDb` for any engine backend ([.smithers/specs/postgres-tanstack-sync.md](/Users/williamcory/smithers/.smithers/specs/postgres-tanstack-sync.md:154)).

### Selecting Other Backends

Use explicit backend selection for non-default modes:

```sh
SMITHERS_BACKEND=pglite smithers workflow run ./workflow.tsx
SMITHERS_BACKEND=pglite smithers ps --all
```

or workspace config:

```ts
// .smithers/smithers.config.ts
export default { backend: "pglite" };
```

For cloud:

```sh
SMITHERS_BACKEND=postgres SMITHERS_POSTGRES_URL=postgres://...
smithers gateway
```

`openSmithersBackend()` already requires a Postgres connection string, env var, or connection object for `postgres` ([packages/smithers/src/openSmithersBackend.js](/Users/williamcory/smithers/packages/smithers/src/openSmithersBackend.js:54), [packages/smithers/src/openSmithersBackend.js](/Users/williamcory/smithers/packages/smithers/src/openSmithersBackend.js:57)).

### Seeded Workflow Policy

Keep seeded workflows on `createSmithers()` for the default. This is the least churn and best matches “use SQLite as much as possible.” It also avoids unproven top-level `await` conversion across all seeded workflows and avoids PGlite socket cost for `workflow run create-workflow`.

For opt-in PGlite/Postgres workflows, document `await openSmithersBackend()` as the required authoring idiom because `createSmithers()` correctly fails loud on non-SQLite requests ([packages/smithers/src/create.js](/Users/williamcory/smithers/packages/smithers/src/create.js:351)).

## 4. Legacy Detection & Migration

### Problem With Current Detection

The current resolver only knows how to inspect SQLite:

- It probes `smithers.db` and `.smithers/smithers.db` ([packages/smithers/src/resolveSmithersBackendChoice.js](/Users/williamcory/smithers/packages/smithers/src/resolveSmithersBackendChoice.js:76), [packages/smithers/src/resolveSmithersBackendChoice.js](/Users/williamcory/smithers/packages/smithers/src/resolveSmithersBackendChoice.js:79)).
- It checks `.smithers/migrated.json` ([packages/smithers/src/resolveSmithersBackendChoice.js](/Users/williamcory/smithers/packages/smithers/src/resolveSmithersBackendChoice.js:109)).
- It throws only for “resolved backend is PGlite/Postgres and SQLite has runs” ([packages/smithers/src/resolveSmithersBackendChoice.js](/Users/williamcory/smithers/packages/smithers/src/resolveSmithersBackendChoice.js:174)).

With SQLite as the new default, the symmetric hazard is now existing PGlite-default 0.25.x users: `.smithers/pg` may contain runs, and a new SQLite default must not silently start an empty `smithers.db`.

### Source of Truth

Physical run history is authoritative.

The resolver should probe known stores and choose/fail based on where runs actually exist:

```ts
type StoreProbe = {
  backend: "sqlite" | "pglite" | "postgres";
  exists: boolean;
  initialized: boolean;
  runCount: number | "unknown";
  schemaVersion?: string;
  location: string;
};
```

Probes:

- SQLite:
  - `smithers.db`;
  - `.smithers/smithers.db` compatibility path;
  - `_smithers_runs` count;
  - `_smithers_schema_migrations` head, matching current logic ([packages/smithers/src/resolveSmithersBackendChoice.js](/Users/williamcory/smithers/packages/smithers/src/resolveSmithersBackendChoice.js:47)).
- PGlite:
  - `.smithers/pg` existence;
  - stable initialization marker such as `PG_VERSION` if present;
  - if initialized, connect through the same pg-wire path and count `_smithers_runs`.
- Postgres:
  - only when explicitly selected or a URL is configured;
  - connect and count `_smithers_runs`.

### Symmetric Rule

The rule is not “SQLite is legacy.” The rule is:

> The store that physically has run history is authoritative. If the resolved/default backend differs from the populated store and no migration receipt or explicit configuration authorizes that divergence, fail loud and offer the correct-direction migration.

Cases:

- Clean install: no stores with runs. Default resolves SQLite. Reads do not provision. First write creates `smithers.db`. No migration error.
- Current default SQLite workspace: SQLite has runs, backend resolves SQLite. No migration error.
- Explicit PGlite/Postgres with populated SQLite and no migration receipt: fail loud with `SMITHERS_MIGRATION_REQUIRED`, preserving current tests and message shape ([apps/cli/tests/migrate-command.test.js](/Users/williamcory/smithers/apps/cli/tests/migrate-command.test.js:68)).
- New SQLite default with populated PGlite and no SQLite runs: fail loud. This is a locked maintainer decision, not an open question. Do not create empty SQLite and do not auto-select PGlite unless `.smithers/backend.json`, config, or env explicitly authorizes PGlite. Error should offer `smithers migrate --from pglite --to sqlite` or `SMITHERS_BACKEND=pglite`.
- Config/env explicitly says PGlite and PGlite has runs: use PGlite.
- Both SQLite and PGlite/Postgres have runs and no migration receipt explains it: fail with `SMITHERS_BACKEND_CONFLICT` or a richer `SMITHERS_MIGRATION_REQUIRED`, never pick one.
- Empty stray SQLite file: ignore for migration purposes, matching existing fresh-workspace expectations ([apps/cli/tests/migrate-command.test.js](/Users/williamcory/smithers/apps/cli/tests/migrate-command.test.js:131)).
- Present `migrated.json`: continue honoring it as a migration receipt because current tests assert it suppresses the guard ([apps/cli/tests/migrate-command.test.js](/Users/williamcory/smithers/apps/cli/tests/migrate-command.test.js:116)).

### Markers

Keep `.smithers/migrated.json` as the migration receipt. It is already written by migration and records source/target details ([packages/smithers/src/migrateSmithersStore.js](/Users/williamcory/smithers/packages/smithers/src/migrateSmithersStore.js:453), [packages/smithers/src/migrateSmithersStore.js](/Users/williamcory/smithers/packages/smithers/src/migrateSmithersStore.js:464)).

Add `.smithers/backend.json` only as an authorization marker, not as the source of truth. Physical probes win when marker and disk disagree.

Marker write ordering:

- Resolution and legacy/conflict detection are pure and never write markers.
- Reads never write markers or provision stores.
- `smithers init` may write a backend marker for the default `sqlite`, but it is not required for correctness.
- A successful first write may write/update marker.
- `smithers migrate` must update marker and `migrated.json`.

This avoids a bad read stamping a marker before the migration gate runs.

## 5. Concrete Code Changes

### `packages/smithers/src/resolveSmithersBackendChoice.js`

Change:

- default from `"pglite"` to `"sqlite"` ([packages/smithers/src/resolveSmithersBackendChoice.js](/Users/williamcory/smithers/packages/smithers/src/resolveSmithersBackendChoice.js:167));
- comment/docs that currently say default `pglite` ([packages/smithers/src/resolveSmithersBackendChoice.js](/Users/williamcory/smithers/packages/smithers/src/resolveSmithersBackendChoice.js:143));
- SQLite-only `inspectLegacySqliteStore()` gate into a multi-store probe;
- returned choice to include backend-specific paths and probe results.

Keep the existing `SMITHERS_MIGRATION_REQUIRED` shape for the sqlite→pglite/postgres legacy case because tests assert message content: db path, run count, schema version, `smithers migrate`, and SQLite opt-out ([apps/cli/tests/migrate-command.test.js](/Users/williamcory/smithers/apps/cli/tests/migrate-command.test.js:68), [apps/cli/tests/migrate-command.test.js](/Users/williamcory/smithers/apps/cli/tests/migrate-command.test.js:75)).

Add new error details for symmetric conflicts:

```txt
Found existing PGlite run history at .smithers/pg, but this version defaults to SQLite.
Migrate it:     smithers migrate --from pglite --to sqlite
Or keep PGlite: SMITHERS_BACKEND=pglite smithers <cmd>
```

### `packages/smithers/src/openSmithersBackend.js`

Keep it as the canonical write-capable workflow opener, but its default choice becomes SQLite through the resolver.

Add:

- `choice` on returned API for logging and cleanup;
- optional `mode: "read" | "write"` only if this remains the shared lower-level primitive;
- no eager `.smithers/pg` creation unless resolved backend is `pglite` and mode is write. Today it creates the parent directory before opening PGlite ([packages/smithers/src/openSmithersBackend.js](/Users/williamcory/smithers/packages/smithers/src/openSmithersBackend.js:75), [packages/smithers/src/openSmithersBackend.js](/Users/williamcory/smithers/packages/smithers/src/openSmithersBackend.js:76)).

### New `packages/smithers/src/openSmithersStore.js`

Implement backend-aware reads/writes for commands that need `SmithersDb`, not workflow authoring helpers.

Important cleanup rule:

- SQLite: do not double-close Drizzle/bun handles. `createSmithers()` already installs a process exit close hook and warns why explicit close matters ([packages/smithers/src/create.js](/Users/williamcory/smithers/packages/smithers/src/create.js:391), [packages/smithers/src/create.js](/Users/williamcory/smithers/packages/smithers/src/create.js:406)). For direct read-only SQLite opens, own the handle and close it once.
- PGlite/Postgres: call `api.close()`; that closes pg client and PGlite server where applicable ([packages/smithers/src/create.js](/Users/williamcory/smithers/packages/smithers/src/create.js:546)).

Do not use a generic `api.db?.$client?.close?.()` cleanup for all backends.

### `apps/cli/src/find-db.js`

Refactor:

- `findAndOpenDb()` calls `openSmithersStore({ cwd: from, mode: "read", wait: opts })`;
- it no longer calls `waitForSmithersDb()` for PGlite/Postgres;
- it returns `{ adapter, cleanup, choice, dbPath? }`.

Keep:

- `findSmithersDb()` and `openSmithersDb()` as SQLite-specific helpers;
- SQLite unit tests for explicit SQLite behavior.

Update readiness:

- SQLite detached reads still poll for `smithers.db`.
- PGlite detached reads poll for initialized `.smithers/pg` plus successful connection/schema presence.
- Postgres detached reads poll connection plus `_smithers_runs`/schema availability.
- Empty workspace read remains `CLI_DB_NOT_FOUND` and does not create a store.

Current direct SQLite behavior lives at [apps/cli/src/find-db.js](/Users/williamcory/smithers/apps/cli/src/find-db.js:28), [apps/cli/src/find-db.js](/Users/williamcory/smithers/apps/cli/src/find-db.js:85), and [apps/cli/src/find-db.js](/Users/williamcory/smithers/apps/cli/src/find-db.js:111).

### `apps/cli/src/index.js`

Run path:

- Keep `--backend` on `up` for workflows using `openSmithersBackend`; it already exists in `upOptions` ([apps/cli/src/index.js](/Users/williamcory/smithers/apps/cli/src/index.js:1378)).
- Default run path remains SQLite and seeded workflows can keep `createSmithers()`.
- Replace `setupSqliteCleanup(workflow)` at run and all workflow-load sites with `registerWorkflowCleanup(workflow)` ([apps/cli/src/index.js](/Users/williamcory/smithers/apps/cli/src/index.js:1873)).

Gateway:

- Remove `dbPath = findSmithersDb(...)` from generic startup ([apps/cli/src/index.js](/Users/williamcory/smithers/apps/cli/src/index.js:2167)).
- Resolve workspace anchor, then backend choice.
- Pass `dbPath` only for SQLite.
- Register cleanup for `workspaceApi` and every discovered workflow.
- For `--backend pglite|postgres`, workflows still authored with `createSmithers()` will fail on import. That fail-loud behavior is correct, but gateway should surface a clear “workflow is SQLite-only” skip reason, not silently imply missing data.

Reads:

- `ps`, `chat`, `inspect`, `output`, `events`, `logs`, `scores`, etc. already mostly call `findAndOpenDb()`; once it is fixed, they become backend-aware ([apps/cli/src/index.js](/Users/williamcory/smithers/apps/cli/src/index.js:3711), [apps/cli/src/index.js](/Users/williamcory/smithers/apps/cli/src/index.js:3966), [apps/cli/src/index.js](/Users/williamcory/smithers/apps/cli/src/index.js:4461), [apps/cli/src/index.js](/Users/williamcory/smithers/apps/cli/src/index.js:6030)).
- Do not write tests using `ps --backend`; read command schemas do not currently have that flag ([apps/cli/src/index.js](/Users/williamcory/smithers/apps/cli/src/index.js:1432), [apps/cli/src/index.js](/Users/williamcory/smithers/apps/cli/src/index.js:1445), [apps/cli/src/index.js](/Users/williamcory/smithers/apps/cli/src/index.js:1458)). Use env/config unless a separate CLI-wide read backend option is added.

Teardown sites:

- Replace `setupSqliteCleanup()` at `loadWorkflowDb`, run, gateway loop, memory, eval, optimize, graph/output workflow-specific commands, and any direct workflow-load path. The current references include `loadWorkflowDb` ([apps/cli/src/index.js](/Users/williamcory/smithers/apps/cli/src/index.js:116)), run ([apps/cli/src/index.js](/Users/williamcory/smithers/apps/cli/src/index.js:1873)), gateway ([apps/cli/src/index.js](/Users/williamcory/smithers/apps/cli/src/index.js:2187)), and optimize dependency injection ([apps/cli/src/optimize-command.js](/Users/williamcory/smithers/apps/cli/src/optimize-command.js:278)).

### Client/Gateway Sync Code

Make the default UI path explicit and preserve the existing client seam:

- Keep `SyncTransport` as the only consumer-side transport contract for live cache code ([packages/gateway-client/src/sync/SyncTransport.ts](/Users/williamcory/smithers/packages/gateway-client/src/sync/SyncTransport.ts:32)).
- Keep `createSmithersGatewayTransport()` as the gateway WS/RPC adapter ([packages/gateway-client/src/sync/createSmithersGatewayTransport.ts](/Users/williamcory/smithers/packages/gateway-client/src/sync/createSmithersGatewayTransport.ts:33)).
- Keep `createGatewayCollections()` defaulting to gateway sync and only selecting Electric when explicitly configured ([packages/gateway-react/src/sync/createGatewayCollections.ts](/Users/williamcory/smithers/packages/gateway-react/src/sync/createGatewayCollections.ts:84), [packages/gateway-react/src/sync/createGatewayCollections.ts](/Users/williamcory/smithers/packages/gateway-react/src/sync/createGatewayCollections.ts:209)).
- Extend boot/capability config so cloud can supply Electric source information once; do not require each UI/component to decide.
- Keep Electric code dynamically imported and read-side only ([packages/gateway-client/src/sync/createElectricCollection.ts](/Users/williamcory/smithers/packages/gateway-client/src/sync/createElectricCollection.ts:133)).

### Seeded Workflows and Workflow Pack

Do not convert all seeded workflows to top-level `await openSmithersBackend()` for the default. Keep `createSmithers()` in the seeded pack so `workflow run create-workflow` stays SQLite and instant.

Still update docs/prompts to explain:

- curated workflows use SQLite via `createSmithers()`;
- use `await openSmithersBackend()` when authoring a workflow intended to run on PGlite/Postgres.

The repository contains additional development workflows, while
`SEEDED_WORKFLOW_IDS` covers only the six curated init-pack workflows. This
matters because the Gateway discovers every workflow present in a workspace, not
only seeded ones.

If any seeded workflow is converted to async authoring later, first prove top-level `await openSmithersBackend()` through the real MDX/JSX loader and `SMITHERS_HOT=1`.

### `apps/review`

`apps/review` currently constructs a SQLite workflow with `createSmithers()` and an explicit `dbPath` ([apps/review/src/workflow/createReviewWorkflow.tsx](/Users/williamcory/smithers/apps/review/src/workflow/createReviewWorkflow.tsx:40), [apps/review/src/workflow/createReviewWorkflow.tsx](/Users/williamcory/smithers/apps/review/src/workflow/createReviewWorkflow.tsx:46)).

Make the choice explicit:

- if review intentionally uses isolated SQLite artifacts, pass `backend: "sqlite"` and keep it documented;
- otherwise make `createReviewWorkflow()` async and use `openSmithersBackend()` with injected backend options.

For the SQLite-first local default, keeping review SQLite is acceptable only if it is intentionally isolated from workspace backend semantics.

## 6. Migration Path for Existing Users

### General Migration

`smithers migrate` must become multi-directional.

Current implementation is sqlite-source-only:

- imports `bun:sqlite` at module top ([packages/smithers/src/migrateSmithersStore.js](/Users/williamcory/smithers/packages/smithers/src/migrateSmithersStore.js:1));
- target type is only `pglite | postgres` ([packages/smithers/src/migrateSmithersStore.js](/Users/williamcory/smithers/packages/smithers/src/migrateSmithersStore.js:14));
- CLI option only allows `--to pglite|postgres` ([apps/cli/src/index.js](/Users/williamcory/smithers/apps/cli/src/index.js:1418));
- `normalizeTarget()` rejects SQLite ([packages/smithers/src/migrateSmithersStore.js](/Users/williamcory/smithers/packages/smithers/src/migrateSmithersStore.js:58));
- `openSourceStore()` opens a SQLite source only ([packages/smithers/src/migrateSmithersStore.js](/Users/williamcory/smithers/packages/smithers/src/migrateSmithersStore.js:509));
- copy code selects from SQLite and inserts into pg placeholders ([packages/smithers/src/migrateSmithersStore.js](/Users/williamcory/smithers/packages/smithers/src/migrateSmithersStore.js:342), [packages/smithers/src/migrateSmithersStore.js](/Users/williamcory/smithers/packages/smithers/src/migrateSmithersStore.js:362)).

Replace it with backend-pair migration:

```sh
smithers migrate --from sqlite --to pglite
smithers migrate --from sqlite --to postgres --url postgres://...
smithers migrate --from pglite --to sqlite
smithers migrate --from postgres --to sqlite --url postgres://...
smithers migrate --from pglite --to postgres --url postgres://...
smithers migrate --from postgres --to pglite --url postgres://...
```

`--from` can be inferred only when exactly one store has run history. `--to` defaults to the current resolver default (`sqlite`) for the default-flip release.

Copy scope:

- all `_smithers_*` tables;
- `input`;
- output tables;
- memory, cron, scorers, eval/monitor-related tables;
- schema migrations;
- indexes where portable;
- table row counts verified after copy.

Keep the existing guard refusing to merge into non-empty targets ([packages/smithers/src/migrateSmithersStore.js](/Users/williamcory/smithers/packages/smithers/src/migrateSmithersStore.js:320), [packages/smithers/src/migrateSmithersStore.js](/Users/williamcory/smithers/packages/smithers/src/migrateSmithersStore.js:322)).

### Agent-Assisted Migration Fallback

When deterministic `smithers migrate` fails, Smithers should fail clearly and offer an opt-in durable agent workflow to repair/complete the migration. It should not silently switch to agent behavior.

Failure examples:

- schema drift;
- dialect edge cases;
- partial/aborted copy;
- unmapped table;
- output table type mismatch;
- row that will not round-trip;
- target verification mismatch.

On deterministic failure, the CLI exits non-zero with a clear error and a suggested command, for example:

```txt
SMITHERS_MIGRATION_FAILED: deterministic migration stopped while copying _smithers_events.
Source was left intact. Target may contain a partial copy.

Retry deterministic migration:
  smithers migrate --from pglite --to sqlite --resume

Or run the durable repair workflow:
  smithers migrate --from pglite --to sqlite --agent
```

`smithers migrate --agent` should invoke a built-in seeded workflow, for example `migrate-repair`, shipped with the workflow pack. An equivalent explicit workflow command is also acceptable if it is what the CLI already supports best:

```sh
smithers workflow run migrate-repair -- --from pglite --to sqlite
```

The failed deterministic migrate output must print the exact command that applies to the detected source/target pair.

The agent workflow responsibilities:

1. Open source and target stores in copy-only mode.
2. Read the source state and any partial target state.
3. Diagnose what the deterministic copy could not handle.
4. Complete repair table-by-table and, where necessary, row-by-row.
5. Preserve IDs, timestamps, run relationships, node relationships, output rows, memory, cron, scores, docs, approvals, events, and schema metadata.
6. Verify row counts and key integrity for every copied table.
7. Verify representative row round-trips for JSON/text/blob-ish columns and dialect-sensitive columns.
8. Write the same receipts as the deterministic path only after verified success:
   - `.smithers/migrated.json`;
   - `.smithers/backend.json`.

Safety constraints:

- Source is never destroyed by default.
- Migration is copy-only unless a future explicit destructive flag is introduced.
- The workflow must be idempotent and resumable. It should detect already-copied rows and reconcile them rather than duplicating them.
- It must tolerate a partially copied target from a failed deterministic run.
- It must use Smithers’ own durable engine plus compute/agent tasks so the repair is crash-safe and can resume.
- Any destructive cleanup, target reset, source archive, or source deletion requires an explicit human-approval gate.
- It must not write `migrated.json` or `backend.json` until verification succeeds.

Where it lives:

- Seed a built-in `migrate-repair` workflow in the pack so it ships with Smithers.
- Make `smithers migrate --agent` discover and invoke that built-in workflow.
- The deterministic failure message should mention both `smithers migrate --agent` and the underlying workflow identity for debuggability.

CI constraint:

- CI e2e should cover the deterministic path because CI has no agent CLIs and no browsers.
- The agent fallback should be covered by a compute-task fixture variant where possible, or documented as manually tested until the durable agent runtime is available in CI.
- Tests must still prove source-intact and receipt-after-success semantics for the agent path, even if the “agent reasoning” portion is replaced by a deterministic compute task fixture in CI.

### Existing SQLite Users

With the new SQLite default:

- SQLite users remain on SQLite.
- No migration prompt appears on normal `ps`/`inspect`/`output`.
- If they opt into `pglite`/`postgres` while SQLite has runs and no migration receipt, fail loud and offer:

  ```sh
  smithers migrate --from sqlite --to pglite
  smithers migrate --from sqlite --to postgres --url ...
  ```

Existing `SMITHERS_BACKEND=sqlite` behavior stays valid and tested ([apps/cli/tests/migrate-command.test.js](/Users/williamcory/smithers/apps/cli/tests/migrate-command.test.js:99)).

### Existing PGlite Users

This is the new default-flip hazard, and the decision is locked: fail loud plus migration/opt-out guidance.

If `.smithers/pg` contains runs and SQLite has no runs:

- do not silently create `smithers.db`;
- do not auto-select PGlite merely because it has runs;
- fail loud with guidance:

  ```sh
  smithers migrate --from pglite --to sqlite
  # or
  SMITHERS_BACKEND=pglite smithers ps
  ```

If `.smithers/smithers.config.ts`, `.smithers/backend.json`, or env explicitly selects `pglite`, keep using PGlite.

If both PGlite and SQLite contain runs and no marker explains it, fail as a conflict.

If deterministic `pglite→sqlite` migration fails, offer the agent fallback:

```sh
smithers migrate --from pglite --to sqlite --agent
```

### Existing Postgres Users

Postgres remains explicit because it requires connection configuration. If a Postgres store has runs and the new default would be SQLite, require either explicit `SMITHERS_BACKEND=postgres` plus URL or migration:

```sh
smithers migrate --from postgres --to sqlite --url postgres://...
```

Cloud deployments should pin `backend=postgres` in config/env and are not affected by the local default flip.

If deterministic migration from Postgres fails, offer:

```sh
smithers migrate --from postgres --to sqlite --url postgres://... --agent
```

or the corresponding built-in workflow invocation.

### Backward Compatibility

- `createSmithers()` remains SQLite and synchronous.
- `openSmithersBackend()` remains the async multi-backend API.
- `migrated.json` remains honored.
- Copy-only migration remains the default: source stores are left intact unless an explicit destructive flag is added.
- Existing sqlite→pglite/postgres migration tests remain, but their default expectations must be revised because default target becomes SQLite unless `--to` is specified.
- Existing populated PGlite stores fail loud under the new SQLite default unless explicit config/env/marker selects PGlite. This is intentional data-loss prevention.

## 7. Test Plan / E2E Coverage

### Why Current Tests Missed It

Existing tests cover components, not the full workflow:

- `openSmithersBackend.test.js` locks the old PGlite default ([packages/smithers/tests/openSmithersBackend.test.js](/Users/williamcory/smithers/packages/smithers/tests/openSmithersBackend.test.js:33)).
- `migrate-command.test.js` checks legacy SQLite fail-loud behavior ([apps/cli/tests/migrate-command.test.js](/Users/williamcory/smithers/apps/cli/tests/migrate-command.test.js:57), [apps/cli/tests/migrate-command.test.js](/Users/williamcory/smithers/apps/cli/tests/migrate-command.test.js:78)).
- No test proves `init → run → ps/inspect/output` reads the same physical store.
- Read helper tests are SQLite-shaped because the helper itself is SQLite-shaped ([apps/cli/src/find-db.js](/Users/williamcory/smithers/apps/cli/src/find-db.js:111)).

### Backend Round-Trip Matrix

Add non-gated e2e/integration coverage for SQLite and PGlite, and service-backed CI coverage for Postgres.

Use a compute-only workflow fixture so CI does not need agent CLIs or browsers:

```tsx
/** @jsxImportSource smithers-orchestrator */
import { createSmithers } from "smithers-orchestrator";
import { z } from "zod/v4";

const result = z.object({ value: z.string() });
const { Workflow, Task, smithers, outputs } = createSmithers({ result });

export default smithers(() => (
  <Workflow name="db-roundtrip">
    <Task id="compute" output={outputs.result}>
      {() => ({ value: "ok" })}
    </Task>
  </Workflow>
));
```

For SQLite default:

```sh
smithers init
smithers workflow run .smithers/workflows/db-roundtrip.tsx --run-id rt-sqlite
smithers ps --all
smithers inspect rt-sqlite
smithers output rt-sqlite compute
```

Assert:

- `smithers.db` exists;
- `.smithers/pg` does not need to exist;
- no migration error;
- run and output are visible.

For PGlite:

Use an async fixture authored with `await openSmithersBackend()` and run/read with env:

```sh
SMITHERS_BACKEND=pglite smithers workflow run ./pglite-roundtrip.tsx --run-id rt-pglite
SMITHERS_BACKEND=pglite smithers ps --all
SMITHERS_BACKEND=pglite smithers inspect rt-pglite
SMITHERS_BACKEND=pglite smithers output rt-pglite compute
```

Assert:

- `.smithers/pg` exists;
- no `smithers.db` is required;
- reads see the PGlite run.

For Postgres:

Run in a dedicated CI job with a real Postgres service. Do not env-gate it out of CI. The no-mocks policy requires a real backend. Use:

```sh
SMITHERS_BACKEND=postgres SMITHERS_POSTGRES_URL=... smithers workflow run ./pg-roundtrip.tsx --run-id rt-postgres
SMITHERS_BACKEND=postgres SMITHERS_POSTGRES_URL=... smithers ps --all
```

### Migration Tests

Add pairwise migration tests:

- sqlite→pglite;
- sqlite→postgres;
- pglite→sqlite;
- postgres→sqlite;
- conflict when target has rows;
- inferred `--from` when exactly one store has runs;
- fail when multiple stores have runs and no `--from`;
- existing populated PGlite under the SQLite default fails loud and offers `smithers migrate --from pglite --to sqlite` plus `SMITHERS_BACKEND=pglite`;
- deterministic migration failure offers `smithers migrate --agent` with the correct source/target pair;
- agent fallback fixture preserves source, resumes from partial target, verifies row counts, and writes receipts only after success.

Existing tests to keep green in adjusted form:

- legacy SQLite plus explicit PGlite/Postgres fails loud before migration;
- `SMITHERS_BACKEND=sqlite` reads SQLite;
- `migrated.json` suppresses intended guard;
- fresh workspace never triggers migration guard ([apps/cli/tests/migrate-command.test.js](/Users/williamcory/smithers/apps/cli/tests/migrate-command.test.js:131)).

### Empty Read Test

Add:

```sh
smithers init
smithers ps
```

before any run.

Assert:

- no `SMITHERS_MIGRATION_REQUIRED`;
- no store is provisioned by the read if the command is meant to report no DB yet;
- behavior is stable and documented.

### Gateway/UI Sync Test

Add a local SQLite gateway test with no Electric/Postgres:

1. `smithers init`.
2. Run compute-only SQLite workflow.
3. Start `smithers gateway`.
4. Connect through gateway client/WS/RPC sync source.
5. Assert run list/events update from SQLite-backed `SmithersDb`.

This is the critical sync test: local UI observes SQLite directly through gateway transport.

Also add a collection-registry unit test:

- `createGatewayCollections({ client })` defaults to gateway mode;
- no Electric config is required;
- `syncSource: "electric"` without config falls back to gateway;
- `syncSource: "electric"` with config uses the Electric twin only for collections that have one.

### Cloud Electric Attachment Test

Add a cloud-mode integration or package-level test around the registry seam:

- pass `syncSource: "electric"` plus `electric.shapeUrl`;
- assert `memoryFacts` uses the Electric collection definition;
- assert collections without Electric twins still use gateway RPC;
- assert mutation hooks still call gateway RPC, not Electric;
- assert no PGlite source can be configured as an Electric source.

Where a real Electric service is unavailable in unit tests, keep this at the registry/config seam and cover real Electric proxy behavior in service-backed integration tests.

### Silent Data Loss Regression

Add explicit regression:

1. Create PGlite-native workflow with `await openSmithersBackend()`.
2. Run with `SMITHERS_BACKEND=pglite`.
3. Assert no SQLite `smithers.db` is required.
4. Assert `SMITHERS_BACKEND=pglite smithers ps` shows the run.
5. Assert plain `smithers ps` under the new SQLite default fails loud and offers migration/explicit-PGlite guidance instead of showing empty state.

This catches the current “read path opens SQLite and shows empty” defect.

### Agent Fallback Coverage

Because CI has no agent CLIs, split coverage:

- deterministic path covered in normal CI e2e;
- `--agent` command wiring covered by a fixture/built-in workflow discovery test;
- repair behavior covered by a compute-task variant that simulates the same durable workflow steps without external agent dependencies;
- full agent-assisted repair documented as manually tested until CI has a suitable durable agent runner.

Minimum assertions:

- source remains intact;
- partial target is resumed or reconciled;
- failed repair does not write `migrated.json` or `backend.json`;
- successful repair writes both receipts;
- destructive cleanup requires human approval.

## 8. Phased Rollout

### Phase 1: SQLite Default and Read Opener

Must land together:

- resolver default becomes SQLite;
- `openSmithersBackend.test.js` default expectation changes;
- `findAndOpenDb()` becomes backend-aware;
- empty reads do not provision stores;
- SQLite default `init → run → ps` e2e passes.

This fixes the reported clean-init path with minimal churn because seeded workflows already use SQLite.

### Phase 2: Symmetric Store Probes and Conflict Gate

Add PGlite/Postgres probes and symmetric fail-loud detection.

Must include:

- existing PGlite run history is not hidden by new SQLite default;
- populated PGlite plus no explicit PGlite selection fails loud with `smithers migrate --from pglite --to sqlite` or `SMITHERS_BACKEND=pglite`;
- explicit env/config keeps PGlite usable;
- conflict when multiple stores have runs;
- current legacy SQLite fail-loud tests remain valid when resolving to non-SQLite.

### Phase 3: Multi-Directional Migration

Make `smithers migrate` backend-pair based.

This is a launch gate for the default flip if there are real 0.25.x PGlite-default users. At minimum, pglite→sqlite must ship before the release that defaults to SQLite.

Also include deterministic failure handling:

- clear non-zero error;
- source-intact guarantee;
- resume guidance where possible;
- opt-in agent repair command printed with the exact detected `--from`/`--to`.

### Phase 4: Agent-Assisted Migration Repair

Ship the seeded `migrate-repair` workflow and `smithers migrate --agent` wrapper.

Must include:

- workflow discovery/invocation from failed migrate output;
- table-by-table and row-by-row repair semantics;
- crash-safe durable execution;
- source-intact and idempotent/resumable behavior;
- row-count/key verification;
- receipt writes only after success;
- human-approval gate before destructive operations.

This can land after deterministic pglite→sqlite if deterministic migration is strong enough for the default flip, but it must be part of the migration design before broad rollout.

### Phase 5: Gateway and Sync Source Validation

Fix gateway DB path plumbing and add local SQLite gateway sync test.

Must include:

- no `findSmithersDb()` requirement for PGlite/Postgres gateway startup;
- SQLite gateway live UI path with no Electric/Postgres;
- backend-aware cleanup for workspace and discovered workflows;
- boot/capability path for selecting Electric in cloud without UI component branching.

### Phase 6: Cleanup Across Workflow Load Sites

Replace all `setupSqliteCleanup()` usages with backend-aware cleanup.

This includes run, gateway, memory, eval, optimize, graph/output workflow-specific commands, TUI detached wait/open logic, and scheduler read acquisition.

### Phase 7: Secondary Apps and Authoring Docs

Update:

- `apps/review`;
- generated workflow authoring prompts;
- docs around `createSmithers()` vs `openSmithersBackend()`;
- seeded pack only where text changes require regeneration;
- docs around local gateway sync as the default client path and Electric as cloud read-side sync.

Do not globally convert seeded workflows unless there is a specific PGlite/Postgres requirement.

### Phase 8: Postgres/Electric Cloud

After Postgres engine backend is green in CI:

- Electric proxy/shapes;
- real Postgres logical replication prerequisites;
- cloud `SyncSource` selection through boot capability/config;
- no PGlite-as-Electric-source path;
- TanStack DB Electric collections added incrementally behind `electricCollectionDefs`.

This follows the existing sync spec’s cloud-only Electric directive ([.smithers/specs/postgres-tanstack-sync.md](/Users/williamcory/smithers/.smithers/specs/postgres-tanstack-sync.md:302), [.smithers/specs/postgres-tanstack-sync.md](/Users/williamcory/smithers/.smithers/specs/postgres-tanstack-sync.md:314)).

## 9. Open Questions / Decisions for Maintainer

1. Existing populated PGlite stores under the new SQLite default: decided.

   Fail loud. Do not auto-select PGlite without explicit env/config/marker. Offer:

   ```sh
   smithers migrate --from pglite --to sqlite
   # or
   SMITHERS_BACKEND=pglite smithers <cmd>
   ```

2. Should read commands get a shared `--backend` option?

   Recommendation: not in the first fix. Use env/config for reads, as current tests already do. Add a shared read option later only if UX demands it.

3. Should `.smithers/backend.json` be written by `smithers init`?

   Recommendation: optional. Physical probes should drive safety. If written, treat it as authorization/context, not truth over populated stores.

4. Should seeded workflows ever move to `await openSmithersBackend()`?

   Recommendation: not for the default. Keep `createSmithers()` for SQLite-first local workflows. Use async authoring only for workflows intended to run on PGlite/Postgres.

5. What is the default `smithers migrate` target after the flip?

   Recommendation: `sqlite`, because it matches the new local default. Require explicit `--to pglite|postgres` for non-default migrations.

6. How strict should gateway be when `--backend pglite|postgres` loads SQLite-only `createSmithers()` workflows?

   Recommendation: keep the workflow-level fail-loud import error, but make gateway reporting explicit and test it. Do not silently mount a SQLite workflow into a non-SQLite gateway.

7. What should select Electric vs gateway sync on the client?

   Recommendation: server-provided boot capability is the single source of truth. Extend `GatewayUiBootConfig` with an optional sync capability containing `source: "gateway" | "electric"` and, for Electric, `shapeUrl`. Local omits it or sets gateway. Cloud sets Electric. UI code passes that once into `createGatewayCollections()`.

8. How much of the agent-assisted migration fallback must be CI-gated?

   Recommendation: deterministic migration remains the CI e2e gate. The agent fallback should have CI coverage for command wiring, workflow discovery, source-intact behavior, partial-target repair semantics, and receipt ordering using a compute-task fixture. Full external-agent repair can be manually tested until CI has agent CLIs.
