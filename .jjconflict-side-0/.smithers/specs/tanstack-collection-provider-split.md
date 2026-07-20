# TanStack DB as the frontend layer, collection provider per workspace mode

The UI reads and writes exclusively through TanStack DB collections. The
collection *implementation* is swapped by workspace mode: a REST+SSE provider
over local SQLite, or an Electric provider over cloud Postgres. Components,
schemas, collection names, live queries, and the mutation API are identical in
both modes.

Status: design, decided. This is the canonical decision for the UI data layer.
It supersedes the open questions in the specs listed under "Relationship to
existing specs". Nothing here is implemented yet — the current UI still runs on
the bespoke gateway-WS transport described in "What this replaces".

---

## The rule

Do **not** make local SQLite mode pretend to be Electric. Do **not** invent a
database-agnostic sync engine. Let TanStack DB be the stable frontend database.
Swap only the collection provider underneath it.

```
UI components
  → TanStack DB collections            (stable: same names, schemas, live queries)
      → local workspace  → QueryCollection (REST) + SSE invalidation → SQLite
      → multiplayer       → ElectricCollection → Electric shapes → Postgres
  write path (both)       → Smithers domain API → the mode's DB
```

TanStack DB explicitly supports multiple collection sources — `QueryCollection`
for REST/API data, `ElectricCollection` for Postgres via Electric, and custom
collection-options creators — and lets both patterns coexist so components do
not know where the data came from.

## Modes

```
Local read:     SQLite → REST → QueryCollection → TanStack DB
Local write:    TanStack DB mutation → local API → SQLite → SSE invalidation → refetch
Multiplayer read:  Postgres → Electric → ElectricCollection → TanStack DB
Multiplayer write: TanStack DB mutation → cloud API → Postgres → Electric confirmation
```

Local mode needs **no row-level sync**. Reactivity is: SQLite write commits →
daemon emits `{ seq, collections: ["runs","events"] }` over SSE → frontend
invalidates those TanStack Query keys → live queries update. Optimize
invalidate-and-refetch into row patches later; do not start there.

Multiplayer mode uses Electric shapes for reads; writes still go through the
Smithers cloud API, which returns a `txid` so Electric transaction-matching can
confirm the optimistic state.

## Conceptual model

- TanStack DB is the frontend database.
- SQLite is the local persistence engine (source of truth in local mode).
- Postgres + Electric is the multiplayer sync engine.
- The Smithers domain API is the write path in **both** cases.

## Core code shape

```ts
type WorkspaceMode =
  | { kind: "local"; apiBaseUrl: string }
  | { kind: "multiplayer"; apiBaseUrl: string; electricBaseUrl: string; workspaceId: string }
```

A collection factory returns the same-named collections regardless of mode:

```ts
export function createSmithersCollections(mode: WorkspaceMode, queryClient: QueryClient) {
  return {
    runs: createRunsCollection(mode, queryClient),
    tasks: createTasksCollection(mode, queryClient),
    events: createEventsCollection(mode, queryClient),
    // workflows, artifacts, approvals, scores, prompts, tickets, memoryFacts …
  }
}
```

Local = `queryCollectionOptions` (REST) with `onInsert/onUpdate/onDelete`
posting to the local API. Multiplayer = `electricCollectionOptions` with a
`shapeOptions.url` of `${electricBaseUrl}/v1/shape` scoped by
`where: workspace_id = '<id>'`, same mutation handlers pointed at the cloud API.
Once the local pattern is proven, wrap it in a custom `sqliteCollectionOptions`
creator so app code becomes symmetric:

```ts
const runs = mode.kind === "local"
  ? createCollection(sqliteCollectionOptions({ id: "runs", apiBaseUrl, path: "/api/runs", streamPath: "/api/stream", schema: runSchema, getKey: r => r.id }))
  : createCollection(electricCollectionOptions({ id: "runs", schema: runSchema, getKey: r => r.id, shapeOptions: { url, params }, ...handlers }))
```

The UI only ever does:

```ts
const { data: runs } = useLiveQuery(q => q.from({ run: collections.runs }))
```

## Identical domain API across modes

One interface, two implementations. Collections call the client; components call
collections; nothing else cares which backend answered.

```ts
interface SmithersDataClient {
  listRuns(): Promise<Run[]>
  createRun(input: CreateRunInput): Promise<MutationAck>
  updateRun(id: string, input: UpdateRunInput): Promise<MutationAck>
  deleteRun(id: string): Promise<MutationAck>
  listTasks(): Promise<Task[]>
  listEvents(runId: string): Promise<RunEvent[]>
  // …
}
// class LocalSmithersClient  → Bun daemon backed by SQLite
// class CloudSmithersClient  → Smithers cloud API backed by Postgres
```

## Local daemon surface (Bun)

```
GET/POST /api/runs          PATCH/DELETE /api/runs/:id
GET      /api/tasks
GET      /api/events?runId=…
GET      /api/stream        (SSE: {"seq":123,"collections":["runs","events"]})
```

Frontend:

```ts
const source = new EventSource(`${apiBaseUrl}/api/stream`)
source.addEventListener("change", e => {
  const { collections } = JSON.parse(e.data)
  for (const c of collections) queryClient.invalidateQueries({ queryKey: [c] })
})
```

That is enough for a single local client.

---

## What this replaces (current repo state)

The UI today does **not** use official TanStack collection creators. It runs a
bespoke stack that this design retires:

- `packages/gateway-react/src/sync/createGatewayCollections.ts` — hand-rolled
  `createCollection` calls fed by a custom gateway transport (RPC + a resilient
  WebSocket `streamRunEvents`/`streamDevTools`) plus an internal
  `INVALIDATE_SCOPE` pulse bus. Lists go live via app-side polling
  (`apps/smithers/src/sync/useLocalModeRefetch.ts`), per-run detail via the WS.
- `packages/gateway-client/src/sync/createElectricCollection.ts` +
  `electricCollectionDefs.ts` — a half-wired Electric twin, only `memoryFacts`,
  behind a dynamic import, never activated by any app (`syncSource` defaults to
  `"gateway"`).
- `apps/smithers/src/**/*Bridge.tsx` — pump hook rows into ~30 zustand stores
  the components actually read.
- The OPFS/SQLite-WASM persistence backends in
  `packages/gateway-react/src/sync/persistence/*` — unused.

Under this design: the local provider is the official `QueryCollection` (REST +
SSE invalidation), the multiplayer provider is the official `ElectricCollection`
(Postgres shapes), and the Bridge→zustand hydration layer goes away — components
read `useLiveQuery` off the collections directly.

Dependencies to add (only `@tanstack/db` + `@tanstack/react-db` are installed
today): `@tanstack/query-db-collection`, `@tanstack/electric-db-collection`,
`@tanstack/react-query`.

Existing gateway RPC methods map to REST routes: `listRuns→GET /api/runs`,
`getRun→GET /api/runs/:id`, `listApprovals/listScores/listPrompts/listTickets/
listMemoryFacts/listWorkflows`, `getDevToolsSnapshot→GET /api/runs/:id/tree`,
`getNodeOutput`, `getNodeDiff`.

## Relationship to existing specs

This decision consolidates and closes:

- `pluggable-db-sync-unification.md` — its "Verdict B" (source-layer swap, never
  in app/UI code) IS this design; this spec makes it concrete.
- `postgres-tanstack-sync.md` — keep its Postgres-of-record + Electric cloud
  half; drop its "local SQLite replica synced via Electric/PGlite" half (Electric
  cannot source from SQLite/PGlite, so local mode uses REST+SSE instead).
- `smithers-sync-sdk.md`, `gateway-extensions-sync-backplane.md` — the "one SDK
  instead of hand-rolled fetch/poll/WS per feature" goal is satisfied by TanStack
  DB collections; those SDKs collapse into the collection factory.
- `pluggable-db-sync-scenarios.md` — its compatibility matrix and real-backend
  test plan apply to the two providers here (local REST+SSE, cloud Electric).

## Why Electric can't just take SQLite (settled)

Electric's sync service tails Postgres logical replication (WAL / logical
decoding, replication slot + publication). It has no pluggable source and no
SQLite path; PGlite can only be a sync *target*, never a source. Forking Electric
to source from SQLite means rebuilding its replication core — far more work than
running the REST+SSE local provider. So local mode does not use Electric at all;
that is the point of the split.

## Build order

1. Canonical schemas: `runs`, `tasks`, `events`, `workflows`, `artifacts` (+
   approvals, scores, prompts, tickets, memoryFacts). Shared by both clients.
2. Local Bun daemon REST API over SQLite (extend the existing gateway/local UI
   server; reuse the current RPC handlers behind REST routes).
3. TanStack DB `QueryCollection`s over the local API; delete the matching
   Bridge/zustand hydration.
4. SSE `/api/stream` invalidation from daemon → frontend.
5. Cloud Postgres API with the same domain routes (returns `txid`).
6. `ElectricCollection`s for cloud mode.
7. Workspace-mode switch selecting the collection factory.
8. One-way "enable multiplayer" migration: SQLite snapshot → Postgres.

Ship 1–4 (local, SQLite, no Postgres) as the MVP; 5–8 land multiplayer later
with zero UI changes.
