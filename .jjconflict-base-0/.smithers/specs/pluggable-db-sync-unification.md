# Clean Smithers Sync Architecture

## Verdict

Choose **B: a necessary evil at the source layer, but not in app/UI/client code**.

A genuine “Electric everywhere + lightweight local DB” path is **not shippable today**. The exact blocking constraint is Electric’s source requirement:

> “Postgres must have logical replication enabled. You also need to connect as a database role that has the REPLICATION attribute.” Electric also creates a logical replication publication and replication slot inside Postgres. Electric’s deployment model has three components: Postgres, the Electric sync service, and the app. Source: Electric deployment docs, lines 160-168, 185-196, 216-229. ([electric.ax](https://electric.ax/docs/guides/deployment))

PGlite’s shipped Electric integration is the opposite direction: it syncs a remote Electric shape **into** PGlite, and explicitly says it does not support local writes being synced out yet. Source: PGlite sync docs, lines 75-78 and 106-126. ([pglite.dev](https://pglite.dev/docs/sync))

There is promising PGlite work in PR #897 for `wal_level=logical`, replication slots, and `pgoutput`, but it is still open and scoped as enablement work, not a documented Electric-source integration. Source: PR #897, lines 172-204 and 224-241. ([github.com](https://github.com/electric-sql/pglite/pull/897))

So: **do not design two client paths. Design one client protocol through the gateway, with one collection contract, and isolate the irreducible divergence behind one server-side backing seam.**

## Recommended Architecture

Smithers should have:

1. **One client protocol:** gateway RPC/WebSocket `SyncTransport`.
2. **One client collection contract:** TanStack DB collections keyed by the same `SyncKey`/fingerprint.
3. **One write path:** gateway actions/RPC.
4. **One server-side sync seam:** a swappable `SyncBacking` inside the gateway.
5. **Two backing implementations only at that seam:**
   - local: read/tail `SmithersDb` over SQLite or PGlite;
   - cloud: read/tail Electric shapes backed by real Postgres.

This is meaningfully one path for app code, `.smithers/ui/*.tsx`, gateway-react hooks, custom UIs, and most engine integration. The only divergence is the unavoidable source-of-record feed.

## Current Repo Grounding

The repo is already close.

`SyncTransport` is the narrow client-facing contract: `rpc()` plus optional `stream()`. Its comment says the SDK is transport-agnostic, and the type is only request/response plus streamed frames: [SyncTransport.ts](/Users/williamcory/smithers/packages/gateway-client/src/sync/SyncTransport.ts:1), [SyncTransport.ts](/Users/williamcory/smithers/packages/gateway-client/src/sync/SyncTransport.ts:32).

`createSmithersGatewayTransport()` adapts the concrete gateway client into that contract and currently supports gateway stream scopes like `streamRunEvents` and `streamDevTools`: [createSmithersGatewayTransport.ts](/Users/williamcory/smithers/packages/gateway-client/src/sync/createSmithersGatewayTransport.ts:33), [createSmithersGatewayTransport.ts](/Users/williamcory/smithers/packages/gateway-client/src/sync/createSmithersGatewayTransport.ts:41).

The current fork is small but real. `createGatewayCollections()` computes `electricConfig` only when `syncSource === "electric"` and an Electric config is present: [createGatewayCollections.ts](/Users/williamcory/smithers/packages/gateway-react/src/sync/createGatewayCollections.ts:204). Then only `memoryFacts` branches between Electric and gateway: [createGatewayCollections.ts](/Users/williamcory/smithers/packages/gateway-react/src/sync/createGatewayCollections.ts:489).

`createElectricCollection()` says it returns a `CollectionConfig` structurally interchangeable with the gateway collection, but it also loads `@electric-sql/client` and opens an Electric `ShapeStream` directly from the browser: [createElectricCollection.ts](/Users/williamcory/smithers/packages/gateway-client/src/sync/createElectricCollection.ts:5), [createElectricCollection.ts](/Users/williamcory/smithers/packages/gateway-client/src/sync/createElectricCollection.ts:24), [createElectricCollection.ts](/Users/williamcory/smithers/packages/gateway-client/src/sync/createElectricCollection.ts:165).

The Electric proxy is currently a standalone read-only sidecar. Its bin says it fronts a real Electric service and derives grants from the gateway: [smithers-electric-proxy.ts](/Users/williamcory/smithers/packages/electric-proxy/bin/smithers-electric-proxy.ts:3). The proxy forwards shape requests to upstream Electric: [createSmithersElectricProxy.ts](/Users/williamcory/smithers/packages/electric-proxy/src/createSmithersElectricProxy.ts:660). It only serves `GET /v1/shape` and rejects non-GET writes: [createSmithersElectricProxy.ts](/Users/williamcory/smithers/packages/electric-proxy/src/createSmithersElectricProxy.ts:712). It also correctly fails closed on unscoped shapes: [createSmithersElectricProxy.ts](/Users/williamcory/smithers/packages/electric-proxy/src/createSmithersElectricProxy.ts:300).

`createGatewayReactRoot()` currently hard-wires gateway transport only, which is the right default for local and the desired final client path: [createGatewayReactRoot.ts](/Users/williamcory/smithers/packages/gateway-react/src/createGatewayReactRoot.ts:20), [createGatewayReactRoot.ts](/Users/williamcory/smithers/packages/gateway-react/src/createGatewayReactRoot.ts:25).

The gateway command already accepts `--backend`, but it still derives a `smithers.db` path before opening the backend, which the pluggable-backends spec calls out as wrong for PGlite/Postgres: [index.js](/Users/williamcory/smithers/apps/cli/src/index.js:1413), [index.js](/Users/williamcory/smithers/apps/cli/src/index.js:2181).

## Unified Contract

Define the sync contract at the gateway boundary, not at Electric.

```ts
type SyncCollectionDef<TRow, TKey> = {
  key: SyncKey;
  getKey(row: TRow): TKey;
  read: {
    method?: string;
    params?: unknown;
    rows?: (payload: unknown) => Iterable<TRow>;
  };
  stream?: {
    scope: string;
    params: unknown;
    frameToRows?: (frame: SyncStreamFrame) => Iterable<TRow>;
    refetchOnFrame?: boolean;
    refetchMode?: "replace" | "merge";
  };
};

type SyncBacking = {
  load(def: SyncCollectionDef<any, any>, signal?: AbortSignal): Promise<unknown>;
  stream(def: SyncCollectionDef<any, any>, opts: SyncStreamOptions): AsyncIterable<SyncStreamFrame>;
};
```

The browser never chooses `gateway` versus `electric`. It always receives:

```ts
createGatewayCollections({
  client: createSmithersGatewayTransport(gatewayClient),
});
```

Cloud changes the **gateway’s backing**, not the UI client.

## Where Divergence Is Isolated

The single seam should live in the gateway/server sync layer:

```txt
gateway-react hooks
  -> createGatewayCollections
  -> SyncTransport rpc/stream
  -> SmithersGatewayClient
  -> Gateway RPC/WS
  -> SyncBacking
       local: SmithersDbBackedSync
       cloud: ElectricBackedSync
```

Local backing:

- uses SQLite by default, or PGlite when explicitly selected;
- initial load calls existing gateway RPC/list methods through `SmithersDb`;
- live stream uses existing event history / invalidation / run-event streams;
- no Electric URL, no `@electric-sql/client`, no Postgres process.

Cloud backing:

- gateway authenticates the same client token;
- gateway opens/tails Electric shapes server-side, likely by reusing the existing `electric-proxy` catalog/auth/scoping code;
- gateway translates Electric shape messages into the same `SyncStreamFrame` deltas used by local streams;
- the browser never talks to `/v1/shape` directly.

This keeps the necessary evil below the gateway, not in consumers.

## Local Default: SQLite, Not PGlite

Under this model, local default should remain **SQLite**.

Reason:

- Electric cannot read from PGlite today, so choosing PGlite locally does not buy a unified Electric path.
- SQLite is lighter: no socket server, no pg client lifecycle, no port allocation.
- The existing pluggable-backends spec already decided the local default should be SQLite and says clean local install should require no Postgres, Electric, socket DB, or migration step: [.smithers/specs/pluggable-db-backends.md](/Users/williamcory/smithers/.smithers/specs/pluggable-db-backends.md:11), [.smithers/specs/pluggable-db-backends.md](/Users/williamcory/smithers/.smithers/specs/pluggable-db-backends.md:21).
- PGlite remains valuable as an explicit local Postgres-dialect backend: [.smithers/specs/pluggable-db-backends.md](/Users/williamcory/smithers/.smithers/specs/pluggable-db-backends.md:30).

If PGlite later ships a documented Electric-source integration, Smithers can add a third backing mode or collapse local PGlite into the Electric backing. The architecture above does not block that.

## What Changes In `pluggable-db-backends.md`

Keep:

- SQLite local default.
- PGlite and Postgres as explicit backends.
- Backend resolution once per entrypoint.
- App/UI code must not branch on backend.
- Writes always through gateway RPC.

Change:

- Replace “cloud UI attaches selected collections to Electric shapes” with “cloud gateway attaches selected server backings to Electric shapes; UI still attaches only to gateway RPC/WebSocket.” Current text says cloud UI attaches through Electric shape URL: [.smithers/specs/pluggable-db-backends.md](/Users/williamcory/smithers/.smithers/specs/pluggable-db-backends.md:40), [.smithers/specs/pluggable-db-backends.md](/Users/williamcory/smithers/.smithers/specs/pluggable-db-backends.md:213).
- Remove `sync?: { source: "gateway" | "electric"; shapeUrl?: string }` from client boot config as the target design. If any boot capability is needed, expose server sync status, not a client transport switch.
- Reframe Electric as a **server backing** rather than a client `SyncSource`.
- Keep `packages/electric-proxy` logic, but plan to embed/reuse it behind gateway or colocate it as an internal gateway service, not as a public browser endpoint.

## Migration Impact

No migration is needed merely for this sync architecture.

Storage migration remains the pluggable-backends problem:

- clean local workspaces default to SQLite;
- explicit PGlite/Postgres workspaces open those stores;
- fail loudly when a selected backend would hide existing run history;
- `openSmithersStore()` should become the shared CLI/server open contract, as the spec proposes: [.smithers/specs/pluggable-db-backends.md](/Users/williamcory/smithers/.smithers/specs/pluggable-db-backends.md:71).

Client migration impact:

- remove the need for browser-visible Electric `shapeUrl`;
- remove or deprecate `syncSource: "electric"` from public `gateway-react`;
- keep collection IDs and `getKey` stable, so persisted TanStack rows can survive where schemas match;
- add replica/schema-version invalidation when shape/frame formats change.

## Phased Plan

1. **Lock the contract**
   - Add a server-side `SyncBacking` interface.
   - Keep client `SyncTransport` as the only public sync protocol.
   - Document that Electric is never selected by UI code.

2. **Make current gateway the default backing**
   - Wrap existing RPC/list and stream behavior as `SmithersDbBackedSync`.
   - Preserve all existing hooks and collection fingerprints.

3. **Move Electric behind gateway**
   - Reuse `smithersElectricShapeCatalog` and proxy auth/scoping.
   - Add gateway stream scope for collection deltas, e.g. `streamCollection`.
   - Translate Electric `insert/update/delete`, `snapshot-end`, `must-refetch`, and replay-gap behavior into `SyncStreamFrame`.

4. **Collapse client branch**
   - Remove `syncSource` selection from `createGatewayCollections`.
   - Remove direct use of `createElectricCollection` from gateway-react.
   - Keep `createElectricCollection` only as internal test/prototyping code or delete it once gateway-backed Electric is proven.

5. **Wire cloud**
   - Cloud gateway config points to Electric upstream.
   - Browser still connects only to gateway RPC/WS.
   - Keep `packages/electric-proxy` as a reusable module or internal sidecar, but not as the client’s sync API.

6. **Clean specs and docs**
   - Update `pluggable-db-backends.md`.
   - Update `postgres-tanstack-sync.md` to say Electric is cloud server backing, not client transport.
   - Document PGlite-as-Electric-source as “watch, not required.”

## Tests

Add or adjust:

- **Gateway local sync tests:** SQLite and PGlite both feed the same `SyncTransport` frames for runs, memory facts, nodes, events.
- **Cloud backing unit tests:** fake Electric shape messages translate to the same collection rows as gateway RPC/list responses.
- **Security tests:** unscoped shapes still fail closed, preserving current proxy behavior from [createSmithersElectricProxy.ts](/Users/williamcory/smithers/packages/electric-proxy/src/createSmithersElectricProxy.ts:313).
- **No browser Electric dependency test:** local and cloud UI bundles should not require direct `@electric-sql/client` unless an internal dev build explicitly opts in.
- **Contract parity tests:** for every collection def, local backing and Electric backing produce identical row shape, key, delete semantics, snapshot reconcile behavior.
- **Gateway command tests:** `smithers gateway --backend sqlite|pglite|postgres` opens the resolved backend without deriving a bogus `smithers.db` path first.
- **E2E:** local `smithers init -> run -> gateway -> UI hook` works without Postgres/Electric; cloud test can use real Postgres + Electric and no client direct shape URL.

## Open Questions

1. Should Electric be tailed by the gateway directly via `@electric-sql/client`, or should the existing `electric-proxy` remain a sidecar and gateway consume its scoped `/v1/shape` endpoint internally?
2. How much fan-out load moves from Electric/CDN to gateway when browsers stop connecting directly to Electric?
3. What is the exact `SyncStreamFrame` representation for Electric snapshot boundaries and `must-refetch`?
4. Should `createElectricCollection()` be deleted after migration, or kept as a lower-level package primitive?
5. When PGlite PR #897 or successors ship, do we add an experimental `PGliteElectricBacking`, or wait for official Electric-reads-from-PGlite docs?

## Final Decision

Do **not** pursue “Electric everywhere” today. It is blocked by Electric’s real Postgres logical replication requirement and PGlite’s lack of a supported Electric-source path.

Do pursue **one gateway sync protocol everywhere**. Local and cloud should differ only behind a thin gateway `SyncBacking`: SQLite/PGlite via `SmithersDb` locally, Electric/Postgres in cloud. This is the cleanest architecture because it satisfies the maintainer’s real goal: one app/UI/client path, one write path, and one place where the unavoidable source divergence lives.
