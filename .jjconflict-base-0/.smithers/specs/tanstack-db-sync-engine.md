# TanStack DB sync engine: implementation spec

Implements the decided design in `tanstack-collection-provider-split.md`. That
doc says *what* and *why*; this one says *where, in what order, and how we know
it works*. Status: engineering spec, execution via the
`tanstack-db-sync-engine` smithers workflow.

Goal, one sentence: building a custom UI on Smithers becomes "call
`createSmithersCollections(mode)` and use `useLiveQuery`" — with local SQLite
served over REST+SSE and multiplayer Postgres served over Electric shapes,
behind the exact same collections.

Breaking changes to `@smithers-orchestrator/gateway-client` and
`@smithers-orchestrator/gateway-react` are allowed and expected. `../multi`
pins published 0.24.x, is not deployed, and is NOT touched by this work; it
migrates later by upgrading.

## Ground truth on main (verified 2026-07-01)

- PR #308 (Postgres-of-record staged sync) was CLOSED unmerged. None of its
  phases are on main.
- The bespoke stack is live: `packages/gateway-client/src/sync/`
  (`createGatewayCollection`, `createSmithersGatewayTransport`, `SyncTransport`,
  `gatewayCollectionDefs`, hand-rolled `createElectricCollection` over
  `@electric-sql/client` `ShapeStream`) and `packages/gateway-react/src/sync/`
  (`createGatewayCollections`, `SyncProvider`, `useGatewayQuery`/`useSyncQuery`
  hooks, unused `persistence/` dir). No zustand/Bridge inside the packages.
- Gateway transport is WS + `/v1/rpc/<method>` POST (openapi.yaml). RPC catalog:
  launchRun, resumeRun, cancelRun, hijackRun, rewindRun, getRun, listRuns,
  listApprovals, submitApproval, submitSignal, streamRunEvents,
  getDevToolsSnapshot, getNodeDiff, getNodeOutput, getSchemaSignature,
  cronList, cronRun, listAccounts, listWorkflows, listDocs, listPrompts,
  listMemoryFacts, listScores, listTickets. There are no REST resource routes
  and no gateway SSE endpoint (serve.js has SSE but it is a separate Hono app).
- Backends: `openSmithersBackend` (packages/smithers) resolves
  sqlite | pglite | postgres; reads go through `SmithersDb` (dialect seam), so a
  read path written once works on all three. NO write path returns a Postgres
  txid today.
- `@smithers-orchestrator/electric-proxy` exists on main and is maintained:
  `createSmithersElectricProxy`, `smithersElectricShapeCatalog` (+ output-table
  shapes), `serveSmithersElectricProxy`, metrics/observer. Scope/auth/rate-limit
  are already its job.
- Installed: `@tanstack/db` 0.6.13, `@tanstack/react-db` 0.1.91. NOT installed:
  `@tanstack/query-db-collection`, `@tanstack/electric-db-collection`,
  `@tanstack/react-query`.

## Locked decisions

1. **TanStack DB is the stable frontend layer.** UI code touches collections and
   `useLiveQuery` only. The collection *provider* swaps per workspace mode.
   Local mode never pretends to be Electric; no database-agnostic sync engine.
2. **The REST domain API lives in the existing gateway HTTP server**
   (`packages/server/src/gateway.js`), NOT a new daemon. It already has the
   http server, the three auth modes (token / jwt / trusted-proxy), scopes, and
   reads through `SmithersDb` — so the same routes serve sqlite, pglite, and
   postgres. Routes are `/v1/api/*`; `/v1/rpc/*` and the WS stay for
   actions/back-compat during the transition.
3. **Local reactivity is SSE invalidation, not row sync.** Committed write →
   `{ seq, collections: [...] }` on `GET /v1/api/stream` → the client
   invalidates those query keys → QueryCollection refetches. Row patches are a
   later optimization, explicitly out of scope.
4. **Multiplayer reads are official ElectricCollection** via
   `@tanstack/electric-db-collection`, shapes served through the existing
   `electric-proxy` (scoping/auth stay there). The hand-rolled
   `createElectricCollection` is retired.
5. **Writes go through the domain API in both modes.** On postgres the write
   handler returns `txid` (captured with `pg_current_xact_id()::xid::text`
   inside the write transaction) so Electric transaction-matching confirms
   optimistic state. On sqlite the ack is `{ seq }` and SSE does the confirm.
   Writes never flow through shapes.
6. **Breaking retirement, one release:** `createGatewayCollection(s)`, the
   `SyncTransport` WS sync path, `electricCollectionDefs`/hand-rolled electric,
   and `gateway-react/src/sync/persistence/` are deleted. The `useGateway*`
   RPC hooks that custom workflow UIs use (`useGatewayRun`,
   `useGatewayRunEvents`, `useGatewayApprovals`, `useGatewayActions`, …) are
   re-implemented ON TOP of the new collections with signatures preserved where
   cheap, renamed where not — the workflow-UI surface
   (`createGatewayReactRoot`) must keep working; `.smithers/ui/*.tsx` are the
   in-repo consumers that prove it.

## Deliverables by milestone

Each milestone is worktree-isolated, chained on the previous branch, and ends
green (typecheck + tests) before commit.

### M1 — REST domain API + SSE invalidation (server)

`packages/server` (+ `packages/gateway` for route/scope types, openapi.yaml).

- `GET/POST /v1/api/runs`, `GET /v1/api/runs/:id`, `POST /v1/api/runs/:id/cancel|resume|rewind`,
  `GET /v1/api/runs/:id/tree`, `GET /v1/api/events?runId=&afterSeq=&limit=`,
  `GET /v1/api/approvals`, `POST /v1/api/approvals/:id` (submit),
  `POST /v1/api/signals`, `GET /v1/api/workflows|docs|prompts|scores|tickets|memory-facts|crons|accounts`,
  `GET /v1/api/nodes/:runId/:nodeId/output|diff`, `GET /v1/api/schema-signature`.
  Handlers delegate to the SAME internal functions the RPC methods use — thin
  route layer, no logic forks. Existing scopes gate each route exactly as the
  RPC twin is gated.
- `GET /v1/api/stream` (SSE): emits `change` events
  `{ seq, collections: string[] }`. Fed by the gateway's existing event tail
  (it already tails `listEventHistory`), mapping event kinds → collection keys
  (runs, events, approvals, …) plus direct pulses from the write handlers.
  Bounded: coalesce within a tick, heartbeat comment every 15s, per-connection
  outbound bound honored.
- Postgres write path returns `txid` (string) in every mutating `/v1/api`
  response; sqlite/pglite return `{ seq }`. One helper in packages/db does the
  capture inside the transaction.
- openapi.yaml gains the `/v1/api/*` routes (it is a gated release artifact).

Acceptance:
- Every `/v1/api` read/write route has a test that runs against BOTH sqlite and
  embedded-PGlite backends (one parameterized suite; real Postgres too when
  `SMITHERS_TEST_PG_URL` is set). No mocks — real `createSmithers*` stores
  seeded deterministically.
- SSE: a committed write produces a `change` frame naming the right collection
  within 1s, on both backends; a burst of N writes coalesces (frames < N);
  slow-consumer test shows bounded buffering.
- txid: on postgres, a write's returned txid matches the txid Electric later
  streams for that row (asserted in M3's e2e; here assert format + presence,
  and absence on sqlite).
- Auth: routes reject missing scope; trusted-proxy headers honored (existing
  auth tests extended to `/v1/api`).

### M2 — Collection factory + local provider (client, breaking)

`packages/gateway-client` + `packages/gateway-react`.

- Add deps: `@tanstack/query-db-collection`, `@tanstack/react-query` (and in M3
  `@tanstack/electric-db-collection`). Keep `@tanstack/db`/`react-db` current.
- `WorkspaceMode` union + `createSmithersCollections(mode, queryClient)` in
  gateway-client: one collection per catalog entry (runs, runTree, events,
  approvals, workflows, docs, prompts, scores, tickets, memoryFacts, crons),
  reusing the existing `Gateway*Row` types as the canonical row schemas.
  Local = `queryCollectionOptions` against `/v1/api/*` with
  onInsert/onUpdate/onDelete posting to the domain API; an SSE subscriber
  invalidates query keys from `change` frames (auto-reconnect with backoff).
  Large blobs (node output, node diff) stay fetch-on-demand by id — never
  collection rows.
- gateway-react: `SmithersCollectionsProvider` mounts the factory +
  QueryClient; hooks become thin `useLiveQuery` wrappers. Preserve the
  workflow-UI hook surface (`useGatewayRun`, `useGatewayRunEvents`,
  `useGatewayNodeOutput`, `useGatewayApprovals`, `useGatewayActions`,
  `useGatewayConnectionStatus`) on top of collections — same stale-data-free
  guarantee. Delete: `createGatewayCollection(s)`, `SyncTransport` sync path,
  `useSync*` internals it fed, `persistence/`, hand-rolled electric files.
- Update the in-repo consumers: `.smithers/ui/*.tsx` bundles and
  `packages/components` (then `pnpm generate:init-pack`).

Acceptance:
- Provider-parity suite: one shared hook/collection test suite executed against
  a REAL gateway on sqlite AND on PGlite/postgres (same tests, parameterized
  fixture). Optimistic insert/update/delete shows instantly, confirms on SSE
  refetch, rolls back on a rejected write.
- Warm behavior: collections repopulate after remount without a full page of
  spinners (initial `queryFn` load), and `runId` switch never shows stale rows.
- `.smithers/ui` bundles build and their existing e2e (real browser harness)
  passes against the new hooks.
- The deleted modules are gone from `index.ts` barrels and `index.d.ts`; the
  packages typecheck with no references left anywhere in the monorepo.

### M3 — Electric provider + txid matching (multiplayer)

`packages/gateway-client` (+ electric-proxy touch-ups only if a shape is
missing from the catalog).

- Multiplayer branch of the factory uses `electricCollectionOptions` with
  `shapeOptions.url = ${electricBaseUrl}/v1/shape` (the electric-proxy),
  params from `smithersElectricShapeCatalog` (workspace/run scoping is the
  proxy's job — the client only passes its auth), mutation handlers = the SAME
  domain-API client as local, returning `{ txid }` for transaction matching.
- Rows arriving from shapes are snake_case Postgres columns; map to the
  `Gateway*Row` camelCase schema in one shared mapper per collection (reuse
  M1's REST serializers so REST and Electric emit identical row shapes —
  asserted by test).

Acceptance:
- The M2 provider-parity suite passes unchanged over the Electric provider
  against a REAL stack: Postgres (wal_level=logical) + electric + the
  electric-proxy via docker compose (reuse `deploy/electric`), gated behind
  `SMITHERS_TEST_ELECTRIC=1` so CI without docker skips cleanly. No mocks.
- txid round-trip: optimistic write held until its txid appears in the shape
  stream, then dropped with no reapply flicker (asserted via `$synced`/state).
- Row-shape parity test: for each collection, REST row === Electric-mapped row
  for the same seeded data.

### M4 — Integrate, docs, matrix, draft PR

- Integrate worktree stacks M1–M3; full gate green: per-package typecheck +
  test for gateway, gateway-client, gateway-react, server, db, smithers, cli,
  electric-proxy, components; `pnpm -C e2e test`; `.smithers/ui` browser e2e.
- Docs are part of the change, not an afterthought: update
  `docs/guides/custom-workflow-ui` + gateway integration docs + a new
  `docs/guides/sync` page (collections, WorkspaceMode, both providers, txid
  contract, SSE protocol), openapi playground source; run `pnpm docs:llms`
  (check-docs / check-llms gate) and `pnpm generate:init-pack`.
- Both-backend matrix run recorded in the PR body: sqlite ✓, pglite ✓,
  postgres (`SMITHERS_TEST_PG_URL`) ✓, electric (`SMITHERS_TEST_ELECTRIC=1`) ✓.
- Draft PR to main; never auto-merges.

## Test doctrine (applies to every milestone)

- No mocks anywhere on these paths. Fixtures are real gateways over real
  stores seeded deterministically; Electric tests run against real Electric.
- Every test touching the domain API or a collection provider is parameterized
  over backends: sqlite + PGlite always; real Postgres when
  `SMITHERS_TEST_PG_URL` is set; Electric when `SMITHERS_TEST_ELECTRIC=1`.
- DI seams (injected fetch/EventSource/base URLs), never `mock.module()`.
- Backpressure is tested: SSE slow consumer, write burst coalescing, events
  collection bounded (ring ≤1024 rows), blobs never persisted in collections.
- CI has no browsers and no agent CLIs: browser e2e and Electric/PG suites gate
  on env and skip loudly (named skip), never fail red.

## Out of scope

- ../multi and ../plue changes (multi upgrades later; plue is reference only).
- Row-level patch sync for local mode; offline persistence (OPFS/SQLite-WASM);
  SQLite→Postgres "enable multiplayer" migration UX (`smithers migrate`
  exists); any Electric-from-SQLite scheme (settled: impossible).
