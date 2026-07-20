# Postgres-of-record + TanStack DB sync to SQLite clients

A design for moving the Smithers stack to a Postgres server of record (PGlite
locally, real Postgres in cloud) that syncs to clients holding a local SQLite
replica, with TanStack DB as the reactive layer over both. Covers DB sync, file
sync (tickets, diffs, logs), how every package changes, how UIs are authored
after the change, and the migration path for existing SQLite users.

Status: design. Decisions locked in the four forks at the end of §3. Nothing in
this doc is implemented beyond what §2 marks as shipped.

---

## 1. Goals

1. **Backend is Postgres-shaped everywhere.** The engine's durable store (`_smithers_*`
   tables + per-schema output tables) runs on PGlite locally and real Postgres in
   cloud. One SQL dialect, one migration system, no SQLite-vs-Postgres drift.
2. **Clients hold a SQLite replica.** The GUI (web PWA and native Electrobun) reads
   from a local SQLite database kept live by sync, so it is fast, offline-capable,
   and reload-warm.
3. **TanStack DB is the reactive layer.** UIs and custom workflow UIs read through
   TanStack DB live queries and write through optimistic mutations, regardless of
   which sync source feeds the collections underneath.
4. **One UI surface over a pluggable sync source.** Local self-host syncs over the
   existing gateway WebSocket+RPC transport; cloud syncs over ElectricSQL shapes.
   A UI is written once and does not know which is underneath.
5. **Files sync too.** `.smithers/tickets/`, `plans/`, `specs/`, run/execution logs,
   and the per-task git diff for any task are available on the client through the
   same sync channel.
6. **Existing SQLite users migrate cleanly** to PGlite/Postgres without losing run
   history, time-travel snapshots, or outputs.

### Non-goals

- Replacing plue's product schema. plue keeps its own repo-scoped tables and its
  own Electric pipeline (see §3 decision 2 and §5.3).
- Running ElectricSQL against local PGlite. Local stays on the gateway transport
  (see §5 and the risk in §11).
- Syncing raw worktree contents or `.jj/` internals. The portable representation
  of a task's filesystem change is the `DiffBundle`, which is already a DB row
  (§6).

---

## 2. What already exists (do not rebuild)

Two big pieces are shipped or in flight. The design builds on them.

### 2.1 Dialect-agnostic persistence (PR #214, merged)

`packages/db` is already dialect-agnostic. The seam lives in
`packages/db/src/dialect.js` and only a handful of things differ between SQLite
and Postgres:

- placeholders `?` to `$1, $2, …`
- `INTEGER` to `BIGINT` (ms timestamps overflow 32-bit), `BLOB` to `BYTEA`,
  `REAL` to `DOUBLE PRECISION`, `INTEGER PRIMARY KEY AUTOINCREMENT` to
  `BIGSERIAL PRIMARY KEY`
- introspection `PRAGMA table_info` to `information_schema.columns`
- transaction start `BEGIN IMMEDIATE` to `BEGIN`
- `json_extract(col,'$.k')` to `(col::json->>'k')`

The storage model is mirrored, not re-modeled: JSON lives in `TEXT`, booleans in
`BIGINT`, blobs in `BYTEA`, so parameter encoding and row decoding stay identical
across dialects. Entry points already present:

- `Smithers.postgres()` / `Smithers.pglite()` layer factories
- async `createSmithersPostgres()` for the JSX API (`packages/smithers/src/create.js:481`)
- `runSmithersSchemaInitPostgres()` (`packages/db/src/schema-migrations.js:519`)

PGlite is reached by running it in socket-server mode
(`@electric-sql/pglite-socket`) and connecting over the same node-postgres wire
path, so there is one pg code path. `pg` and `@electric-sql/pglite*` are optional
dependencies, lazily imported, so SQLite-only users do not load them. Every
workflow feature (linear, sequence, parallel, branch, loop, Ralph, approvals,
crash-recovery, fork/time-travel, continue-as-new) is proven on real Postgres.

**Gap this design closes:** `runSmithersSchemaInitPostgres` creates the schema
fresh and non-versioned. There is no SQLite-to-Postgres data migration and no
data-level versioning on Postgres yet (§9).

### 2.2 TanStack DB collections over the gateway transport (PR #286, open)

`packages/gateway-client` and `packages/gateway-react` are migrated off the
bespoke `SyncClient`/`SyncCache`/`SyncSubscriptionHub` onto TanStack DB:

- `@tanstack/db ^0.6.8` (client), `@tanstack/react-db 0.1.86` (react).
- `createGatewayCollection` is a collection-options-creator: initial load via
  `client.rpc(method, params)`, live updates by subscribing to the existing
  gateway stream (`streamRunEvents` / `streamDevTools`) and applying frames
  through the collection sync writer's `begin() → write() → commit()`.
- Collections: `runs`, `run`, `workflows`, `approvals`, `nodes` (flat
  `childIds`/`parentId` tree rows), `runEvents` (bounded ring, `maxRows: 1024`),
  plus generic `query<T>` and `stream` collections.
- Public hook contract preserved: `useGatewayRuns/Run/Approvals/Workflows/RunEvents`
  still return `GatewayAsyncState<T> = { data, error, loading, refetch }`. New:
  `useGatewayRunTree`, `useGatewayConnectionStatus`, the generic
  `useSyncQuery/Mutation/Subscription` SDK surface.

**Three gaps this design closes:**

1. **No client persistence.** Collections use the default in-memory store with
   `gcTime: 0` on run data (eager teardown). "Clients running SQLite" is greenfield.
2. **Reads are the only first-class path.** Writes are RPC-then-invalidate; no
   `onInsert/onUpdate/onDelete` handlers wired, no optimistic transactions except
   the generic query collection's manual rollback.
3. **Two un-finished edges.** Collection-backed hooks always return
   `error: undefined`; and `apps/smithers` still uses an app-local imperative
   `useGatewayRunTree` in `GatewayRunInspector.tsx`, not the package hook.

### 2.3 plue's Electric pipeline (separate schema, already in production)

plue (`../plue`, Go) is a sister cloud platform, not a host that embeds the TS
engine. It has its own repo-scoped Postgres tables (`workflow_runs`,
`workflow_steps`, `workflow_tasks`, `agent_sessions`, `agent_messages`,
`approvals`, `devtools_snapshots`) defined in `db/schema.sql` (Atlas migrations,
sqlc-generated Go). It already syncs them to clients via the official
`electricsql/electric` service fronted by a custom Go **electric-proxy**
(`cmd/electric-proxy`, `internal/electric/`) that does token auth, `repository_id
IN (...)` scoping, rate limiting (60 shape-opens/min, 50 active), and
user-private shape enforcement (`workspaces`, `workspace_sessions`,
`workspace_snapshots` require `user_id = {authed_user_id}`). Electric runs in
prod (GKE/Helm, `electric.jjhub.tech`), not in plue's dev compose.

This is the **reference implementation** for the smithers-native Electric proxy
in §5.3, and the reason cloud sync rides Electric (decision 1).

---

## 3. Target architecture

```
                 SERVER OF RECORD                 SYNC                       CLIENT
 ┌──────────────────────────────┐   ┌───────────────────────────┐  ┌────────────────────────┐
 LOCAL   PGlite (embedded PG)  ──┼──▶│ gateway WS+RPC (PR #286)   │─▶│ TanStack DB collections │
 self    _smithers_* + outputs    │  │ + SQLite-persisted colls  │  │ persisted to SQLite     │
                                   │  └───────────────────────────┘  │ (sqlite-wasm/OPFS web,  │
 ┌──────────────────────────────┐ │  ┌───────────────────────────┐  │  bun:sqlite native)     │
 CLOUD   Postgres (real)       ──┼──▶│ ElectricSQL shapes         │─▶│ live queries (includes),│
 plue    _smithers_* + outputs    │  │ via smithers-electric-proxy│  │ optimistic writes,      │
                                   │  └───────────────────────────┘  │ $synced view state      │
 └──────────────────────────────┘
   FILES: tickets/plans/specs, logs, sandbox manifests → promoted to DB rows → same sync channel
          per-task git diff is already a DB row (_smithers_node_diffs DiffBundle)
```

The four locked decisions:

1. **Hybrid sync.** Local/self-host syncs over the existing gateway transport.
   Cloud syncs over ElectricSQL shapes. Both feed the same TanStack DB collection
   API. Rationale: Electric needs Postgres logical replication and local embedded
   PGlite is not a viable Electric source (§11), while a single-user local setup
   does not need Electric's fan-out anyway. The gateway transport already works
   against any backend the engine writes (SQLite, PGlite, Postgres) because it
   reads through `SmithersDb`, not the wire.

2. **Native smithers sync; plue keeps its projection.** smithers-orchestrator ships
   its own Postgres + Electric + SQLite-client sync of the `_smithers_*` schema,
   usable self-hosted with zero plue. plue continues mapping runs into its
   repo-scoped product tables and syncing those. `apps/smithers` consumes a
   pluggable sync source (§5.1) so it works against either backend unchanged.

3. **DB-backed file sync.** Loose artifacts (tickets, plans, specs, logs, sandbox
   manifests) are promoted to DB rows and ride the same sync channel. The per-task
   diff is already a row. The client materializes a real on-disk file tree from
   rows when a tool needs files (§6).

4. **Explicit `smithers migrate`.** A one-shot command bulk-copies the old
   bun:sqlite store into PGlite/Postgres through the dialect seam; the old file is
   kept as a backup; client replicas re-sync cold via a `schemaVersion` bump (§9).

### The central abstraction

Everything downstream of the server of record is **one set of TanStack DB
collections fed by a pluggable sync source**. A sync source is a function that,
given a collection definition (table, key, filter), produces TanStack DB
collection options: an initial load plus a live `begin/write/commit` stream.
Today there is one source (gateway transport). This design adds a second
(Electric) and a persistence wrapper, and unifies the write path. UIs never
import a source directly; they import collections and hooks.

---

## 4. The server of record: Postgres / PGlite

### 4.1 Make PGlite the local backend

Today the local default is `bun:sqlite` opened at `.smithers/smithers.db`
(`packages/smithers/src/create.js:391`, path via `findSmithersAnchorDir`). The
target default for new installs is **PGlite** persisted under
`.smithers/pg/` (PGlite's data dir), reached over the pglite-socket wire path
already used by `createSmithersPostgres`.

Changes:

- `createSmithers()` (sync) stays as the bun:sqlite path for back-compat and as
  the migration *source*. It is not removed.
- A new resolution step in the CLI and `create` picks the backend:
  `SMITHERS_BACKEND=pglite|sqlite|postgres` (env) or `backend` in
  `smithers.config.ts`, defaulting to `pglite` for fresh `.smithers/` dirs. When a
  legacy `smithers.db` holds run data and no `migrated.json` exists, the resolver
  does **not** silently switch the user onto either backend: it requires an
  explicit choice (`smithers migrate`, or `--backend sqlite` to stay) and
  otherwise throws `SMITHERS_MIGRATION_REQUIRED` (§9.2). Existing users are never
  silently switched and never silently degraded.
- Because `createSmithersPostgres` is async and `createSmithers` is sync, the CLI
  entry points and `apps/cli/src/index.js` gateway wiring (currently
  `createSmithers({}, { dbPath })` at `~:1950`) move to an async backend factory
  `openSmithersBackend(opts)` that returns the right API. The JSX workflow author
  surface is unaffected: workflows already receive the API from `createSmithers*`.

Cost accepted: PGlite is ~3 MB WASM and runs a socket-server process; it is
slower than bun:sqlite for some workloads but faster for single-row CRUD (it uses
the Postgres WAL). The win is one dialect and one migration system end to end,
and the ability to point local tools at a Postgres they understand.

### 4.2 Schema init and data-level versioning on Postgres

`runSmithersSchemaInitPostgres` currently runs all current DDL fresh. This design
adds:

- A **versioned migration runner for Postgres** mirroring the SQLite one
  (`packages/db/src/schema-migrations.js`). The migration list is shared; each
  migration carries SQLite SQL and a Postgres translation (most fall out of
  `translateDdl`). `_smithers_schema_migrations` becomes the version ledger on
  both dialects. This is required because cloud Postgres is long-lived and will
  need additive migrations after launch, and because the client `schemaVersion`
  (§5.4) is derived from it.
- A `schema_signature` exposed to the sync layer so a client can detect a server
  schema bump and clear its local replica.

### 4.3 What does not change

The `SmithersDb` adapter surface (`insertRun`, `claimRunForResume`,
`upsertOutputRow`, `withTransaction`, `listEventHistory`, …) is unchanged. The
engine, time-travel, and server packages already call it dialect-agnostically.
Output tables are still created from Zod via `zodToCreateTableSQL(…, { dialect })`
with snake_case columns and `(run_id, node_id, iteration)` keys.

---

## 5. The sync layer

### 5.1 The pluggable sync-source seam

Define a `SyncSource` interface in `packages/gateway-client` (extends the existing
`SyncTransport` concept, `createSmithersGatewayTransport.ts`):

```ts
interface SyncSource {
  // Produce TanStack DB collection options for one logical collection.
  collection<Row>(def: CollectionDef<Row>): CollectionConfig<Row>;
  // Connection signal for useGatewayConnectionStatus.
  status(): ConnectionObserver;
}
```

`createGatewayCollection` (PR #286) becomes the **gateway** implementation of this
seam. A new `createElectricCollection` becomes the **Electric** implementation.
`createGatewayCollections` (the registry that `apps/smithers` mounts via
`SyncProvider`) takes a `SyncSource` instead of hard-wiring the transport. The
choice is made once at app boot from `backendStore` (local gateway vs platform
cloud), which already exists (`apps/smithers/src/app/backendStore.ts`).

This is the keystone: it means PR #286's collection definitions, the hook
contract, `useGatewayRunTree`, and every consuming UI are **reused unchanged**
across both sync sources.

### 5.2 Local: gateway transport + persistence

Local keeps PR #286's transport (initial RPC load + `streamRunEvents`/
`streamDevTools` frames applied through `begin/write/commit`). The engine's
out-of-process event bridge (`packages/server/src/gateway.js:2409`) already tails
`listEventHistory(afterSeq)` every ~1000 ms and broadcasts over WS with a bounded
in-memory replay window (10k events/run). This works identically whether the
backend is SQLite, PGlite, or Postgres, because the gateway reads through
`SmithersDb`.

Two PR #286 gaps are closed here:

- **Persistence** (§5.4) is layered on so collections survive reload.
- **Error surfacing**: collection-backed hooks currently return `error: undefined`.
  The `SyncSource` writes a per-collection error into a sidecar status row (mirror
  of the generic `query` collection's `{status, value, error}` row) so hooks can
  surface load errors. This removes the need for the app's connection-status
  workaround.

### 5.3 Cloud: ElectricSQL shapes over `_smithers_*`

> **IMPLEMENTATION DIRECTIVE (2026-06-16, maintainer decision — Phase 7).**
> The phase-7 gate CONFIRMED PGlite (0.5.1) cannot be an Electric source: it runs
> Postgres single-connection with no walsender, so it serves no logical-replication
> slot. Accepted. The clean architecture is therefore:
>
> - **The Electric source is ALWAYS real Postgres, never PGlite.** Cloud = managed
>   Postgres with `wal_level=logical`. Dev/test = a **Dockerized real Postgres +
>   `electricsql/electric` + the smithers-electric-proxy** (e.g. `deploy/electric/
>   docker-compose.yml` + a `tests/fixtures` helper). That real Docker fixture is the
>   NO-MOCKS backend Phase 7 is built and e2e-tested against, and the blueprint for
>   the cloud deploy. Do not fake Electric or stand up nonexistent prod infra.
> - **Local self-host / end user needs NO Electric and NO PGlite-as-source.** They
>   keep the local SQLite client replica synced over the existing gateway transport
>   (built in phase 2). Electric is a cloud-only path.
> - **One clean SyncSource seam, no fragile branches.** `createElectricCollection`
>   is just another implementation of the phase-2 `SyncSource` interface, with the
>   SAME collection shape + key as the gateway source so every gateway-react hook is
>   identical across sources. The source is chosen ONCE at boot from `backendStore`;
>   NO feature/consumer code branches on backend type (`if (backend === …)`).
>   Lazy-import the Electric source only on the cloud path so local loads none of it.
> - **Writes never flow through shapes** — always the gateway/RPC + write-endpoint
>   (Postgres `txid`) path, matching §5.5.

Cloud (real Postgres) syncs via Electric shapes. smithers ships its own Electric
deployment and a **smithers-electric-proxy**, modeled directly on plue's Go proxy
but for the `_smithers_*` schema:

- New package `packages/electric-proxy` (or a server mode in `packages/server`):
  an auth/scope/rate-limit reverse proxy in front of `electricsql/electric`.
- **Shape catalog** = the `_smithers_*` tables, scoped by run and by the caller's
  grant. Each shape has a `where` template the proxy validates and fills:
  - `runs` shape: `where workspace_id IN ({granted}) ` (or unscoped for single-user
    local-cloud).
  - `run` / `nodes` / `attempts` / `events` / `approvals` / `node_diffs` shapes:
    `where run_id IN ({granted_run_ids})`.
  - output tables: shape per output table, `where run_id IN (...)`.
- **Auth mapping.** The gateway scope model (`run:read/write/admin`,
  `approval:submit`, `signal:submit`, `observability:read`,
  `packages/gateway/src/auth/scopes.ts`) maps onto shape access: `run:read` gates
  read shapes; writes never flow through shapes (§5.5). The proxy strips the
  `Authorization` header before forwarding to Electric, exactly as plue does.
- **Logical replication.** Electric consumes the Postgres logical replication
  stream; the smithers cloud Postgres must have `wal_level=logical`, a publication
  over `_smithers_*` + output tables, and a replication slot. This is a deploy
  requirement, documented in the cloud-execution spec.
- **Reuse vs reimplement.** Where smithers runs *inside* plue, plue's existing Go
  proxy and repo-scoped tables stay as-is; the smithers-native proxy is for
  self-hosted cloud and for syncing the raw `_smithers_*` schema. The two do not
  have to converge (decision 2).

`createElectricCollection` uses `@tanstack/electric-db-collection`
(`electricCollectionOptions`) with `shapeOptions` pointed at the proxy URL. Initial
sync + live deltas come from Electric; the TanStack DB collection shape and key
match the gateway source so hooks are identical.

### 5.4 Client persistence: TanStack DB to SQLite

This is the "clients running SQLite" requirement, and TanStack DB 0.6 makes it
first-class. TanStack DB 0.6 standardized on **SQLite as the single persistence
engine** across browser (SQLite-WASM), Node, Electron, Tauri, React Native, and
CF Durable Objects.

- Wrap every synced collection in `persistedCollectionOptions({ persistence,
  schemaVersion })`.
- `persistence` is a platform adapter: SQLite-WASM (OPFS) in the web PWA,
  `bun:sqlite` in the Electrobun native build. One file under the app's data dir
  (web: OPFS; native: app support dir).
- `schemaVersion` is derived from the server `_smithers_schema_migrations` head
  (§4.2). Bumping it clears the local copy and triggers a cold re-sync. This is
  also the **client migration lever** (§9): when the server schema changes, every
  client re-syncs from scratch rather than running client-side DDL.
- The server stays authoritative. Persistence is a durable cache for fast
  startup, offline reads, and reconciliation when sync resumes. It is not a
  second source of truth.

Sizing: the heavy/large rows (node outputs ≤100 MiB, full diffs ≤50 MiB) stay
**RPC-on-demand by id** as in PR #286 and are never persisted into collections.
Persisted collections hold run/node/event/approval/ticket-index rows, which are
small.

### 5.5 Writes: optimistic mutations, unified

Writes unify on TanStack DB optimistic transactions, with a per-source commit
path:

- **Gateway source:** a mutation handler issues the existing RPC (`submitApproval`,
  `launchRun`, `submitSignal`, `cancelRun`, …) and on success lets the live stream
  reconcile. The optimistic write shows instantly; the stream frame confirms it.
- **Electric source:** the mutation handler `POST`s to a smithers write endpoint
  that returns the Postgres `txid`; the collection holds the optimistic state
  until that `txid` appears in the Electric stream, then drops it. This is the
  standard Electric + TanStack DB txid-matching pattern and avoids the
  optimistic-then-reapply flicker.
- `useGatewayMutation` / `useSyncMutation` keep their signatures. Internally they
  move from "RPC then invalidate" to "collection mutate (optimistic) then handler
  commit", so consumers do not change.
- The `$synced` virtual prop is surfaced through the hooks so a UI can show
  pending-vs-confirmed state (for example, an approval button that is visibly
  optimistic until the engine confirms).

Writes never flow through Electric shapes (read-only by construction). The
gateway/RPC + write-endpoint path remains the system of record for auth, audit,
and backpressure, matching the sync-backplane spec's "writes flow through
actions, not shapes" rule.

### 5.6 Collection catalog

| Collection | Source rows | Key | Local source | Cloud shape | Persisted? |
|---|---|---|---|---|---|
| `runs` | `_smithers_runs` (summary) | `run_id` | `listRuns` + invalidate | `runs` shape | yes |
| `run` | `_smithers_runs` (one) | `run_id` | `getRun` + `streamRunEvents` | `run` shape | yes |
| `nodes` | derived from frames/snapshot | `id` | `getDevToolsSnapshot` + `streamDevTools` | `nodes`+`attempts` shapes | yes |
| `runEvents` | `_smithers_events` | `seq` | `streamRunEvents` ring | `events` shape (bounded) | ring only |
| `approvals` | `_smithers_approvals` | `run:node:iter` | `listApprovals` + invalidate | `approvals` shape | yes |
| `workflows` | gateway registry | `key` | `listWorkflows` + invalidate | n/a (registry) | yes |
| `tickets` | `_smithers_tickets` (new, §6) | `path` | RPC + invalidate | `tickets` shape | yes |
| node output | output tables | by id | `getNodeOutput` RPC | RPC | no (on-demand) |
| node diff | `_smithers_node_diffs` | by id | `getNodeDiff` RPC | RPC | no (on-demand) |

The `nodes` collection maps onto TanStack DB **`includes`** for the run-tree UI:
project the flat `childIds`/`parentId` rows into a hierarchical
`run → nodes → attempts` shape in a single live query with no N+1. This also
finishes PR #286's loose edge by replacing the app-local imperative
`useGatewayRunTree` with the package hook.

---

## 6. File and artifact sync (DB-backed)

The split today: DB rows (events, frames, outputs, `_smithers_node_diffs`,
workspace checkpoints) versus loose files (`.smithers/tickets|plans|specs|proposals/*.md`,
`.smithers/executions/*/logs/stream.ndjson`, `.smithers/runs/*/stream.ndjson`,
sandbox bundles). Decision 3 promotes the loose files that matter into rows so
one sync channel covers them.

### 6.1 Tickets, plans, specs, proposals

New table `_smithers_docs` (or `_smithers_files`), one row per markdown artifact:

```
path TEXT,            -- e.g. "tickets/smithers/0030-jjhub-sse-seam.md"
kind TEXT,            -- ticket | plan | spec | proposal
content TEXT,         -- the markdown
content_hash TEXT,
updated_at_ms BIGINT,
deleted_at_ms BIGINT, -- tombstone for sync delete
PRIMARY KEY (path)
```

- A file watcher in the engine (reuse the durability watcher seam,
  `packages/engine/src/startDurability.js`) upserts rows on local edits, so the
  existing "tickets are loose markdown" authoring keeps working.
- The `tickets` collection (§5.6) syncs these rows.
- On the client, a small materializer writes rows back out to a real on-disk tree
  when a tool needs files (the inverse of the watcher). This keeps `.smithers/tickets/`
  real for agents that read the filesystem, while the row is the synced source of
  truth.
- Conflict model: last-write-wins on `content_hash` mismatch with a recorded
  conflict marker row, surfaced in the UI. Tickets are low-contention; this is
  enough.

### 6.2 Per-task git diff

Already solved by DB sync. `smithers diff` / `getNodeDiff` produces a
`DiffBundle = { seq, baseRef, patches[] }` (`packages/engine/src/effect/DiffBundle.ts`)
cached in `_smithers_node_diffs` keyed by `(run_id, node_id, iteration, base_ref)`.
"Sync the git diff for any task" = sync (or fetch on demand) that row. Because
diffs can be large (≤50 MiB), they stay **RPC-on-demand by id**, not persisted,
exactly like node outputs. The diff is portable and self-contained, so the client
never needs the raw worktree or `.jj/`.

### 6.3 Logs

`_smithers_events` is already the read-optimized event store and is synced as the
`runEvents` collection. The loose NDJSON logs (`executions/*/logs/stream.ndjson`)
are the append log behind it. They do not need a second sync path; the event rows
carry the same information. Sandbox bundle manifests are summarized into a row
(status, output refs, diff ref); the bundle's large `patches/` and logs stay
on-demand by id like diffs.

### 6.4 What is not synced as files

Worktree contents and `.jj/` internals. They are live local state. Restore and
time-travel already work from snapshot metadata
(`_smithers_workspace_states`/`_smithers_workspace_checkpoints`) plus jj, which
are local concerns, not client-sync concerns.

---

## 7. Package-by-package change list

| Package | Change |
|---|---|
| `packages/db` | Versioned Postgres migration runner mirroring SQLite (§4.2); `schema_signature` accessor; new `_smithers_docs` table + DDL in the shared migration list; data-copy helpers for `smithers migrate` (§9). |
| `packages/engine` | File watcher upserts `_smithers_docs` rows (reuse durability watcher); no change to the durable execution model. |
| `packages/smithers` | `openSmithersBackend(opts)` async factory that resolves pglite/sqlite/postgres and returns the API; default `pglite` for fresh dirs; runs the migration check and throws `SMITHERS_MIGRATION_REQUIRED` when a legacy store needs an explicit decision (§9.2). |
| `packages/errors` | New `SMITHERS_MIGRATION_REQUIRED` error code with an actionable message (file, run count, schema version, exact next command). |
| `packages/gateway` | Map gateway scopes to Electric shape access for the proxy; expose `schema_signature` over RPC; (optionally) implement `gateway.extend` server side (§8.3, currently spec-only). |
| `packages/server` | Backend factory wiring async; smithers-electric-proxy mode (or new `packages/electric-proxy`); a write endpoint that returns Postgres `txid` for Electric mutation commit (§5.5); keep the out-of-process event bridge for the gateway source. |
| `packages/gateway-client` | `SyncSource` seam (§5.1); `createElectricCollection` via `@tanstack/electric-db-collection`; per-collection error sidecar row; `createGatewayCollection` refactored to implement `SyncSource`. |
| `packages/gateway-react` | `persistedCollectionOptions` wrapper + platform persistence adapters (SQLite-WASM web, bun:sqlite native); `schemaVersion` plumbing; unify mutations onto optimistic transactions; surface `$synced` and per-collection `error`; `useGatewayRunTree` on `includes`. |
| `apps/smithers` | Pick `SyncSource` from `backendStore` at boot; mount persisted collections via `SyncProvider`; finish PR #286 by deleting the app-local imperative `useGatewayRunTree` and using the package hook; web SQLite-WASM/OPFS bundling in Vite. |
| `apps/cli` | `smithers migrate` command (§9); gateway/up commands move to the async backend factory; `--backend` flag. |
| `packages/electric-proxy` (new) | Auth + scope + rate-limit reverse proxy in front of `electricsql/electric`, shape catalog over `_smithers_*`, modeled on plue's Go proxy. |
| `deploy` / cloud | Postgres with `wal_level=logical`, publication over `_smithers_*`, Electric service, proxy. Documented alongside the cloud-execution spec. |

New dependencies: `@tanstack/electric-db-collection` (client), the TanStack DB
SQLite persistence adapters (react), SQLite-WASM for the web build. All additive;
the SQLite-only and no-cloud paths do not load Electric.

---

## 8. How UIs are built after this change

### 8.1 Before

Every gateway-aware surface hand-rolled the same loop: `useEffect` to
`gatewayRpc`, `useState`, a stale-response guard, a WebSocket subscription with a
reconnect loop and replay cursor. The sync-backplane spec calls these "the same
six bugs every time": stale response wins, subscription leak after unmount,
reconnect storm, unbounded payload, forgotten scope check, namespace clash. PR
#286 moved the in-tree app onto collections but kept everything in memory and
read-only.

### 8.2 After

A UI (in-tree page or custom workflow UI) reads through a **live query** and
writes through an **optimistic mutation**. The collection is persisted to SQLite
and fed by whichever sync source the app booted with. The author writes:

```tsx
// read: a live query over a persisted, synced collection
const { data: tree } = useGatewayRunTree(runId);     // includes-projected hierarchy
const { data: approvals } = useGatewayApprovals({ runId });

// write: optimistic, source-agnostic
const approve = useGatewayMutation("submitApproval");
await approve({ runId, nodeId, iteration, decision }); // shows instantly, $synced flips on confirm
```

No fetch loop, no reconnect code, no stale guard, no cache busting. The six bugs
are handled once in the sync source. Cold start is warm because the collection
rehydrates from SQLite before the first frame arrives. Offline reads work.

### 8.3 Custom workflow UIs

The convention is unchanged: `ui/<key>.tsx`, bundled by the workflow-pack system,
mounted via `createGatewayReactRoot`, embedded in `apps/smithers` as an iframe at
`/gw/$key/$runId`. What changes is that an embedded UI gets the **same persisted,
synced collection hooks** the in-tree app uses, because `createGatewayReactRoot`
mounts the `SyncProvider` with the same registry.

The `gateway.extend` sync-backplane spec
(`.smithers/specs/gateway-extensions-sync-backplane.md`) is the natural home for
extension-provided collections: the client hooks (`useGatewayExtensionResource/
Action/Stream`, `extensionRpc`, `streamExtension`) already exist; the **server
side is still unimplemented**. This design does not require it, but an extension's
`streams` become just another `SyncSource`-backed collection when it lands, and
its `resources` are RPC-on-demand. Implementing `gateway.extend` is folded into §7
`packages/gateway` as optional follow-on, not a blocker.

---

## 9. Migration for existing SQLite users

Decision 4: an explicit `smithers migrate`.

### 9.1 Server-side data migration (bun:sqlite to PGlite/Postgres)

```
smithers migrate [--to pglite|postgres] [--url <pg-url>] [--keep-sqlite]
```

1. Open the legacy `.smithers/smithers.db` (bun:sqlite) read-only.
2. Open/boot the target (PGlite under `.smithers/pg/`, or a Postgres URL) and run
   the full versioned schema init (§4.2).
3. Bulk-copy every `_smithers_*` table and every output table through the dialect
   seam. The storage models are mirrored (JSON in TEXT, bool in BIGINT, blob in
   BYTEA), so the copy is row-for-row with parameter re-encoding only; the
   `pg.types.setTypeParser(20, Number)` rule keeps BIGINT booleans correct.
4. Copy `_smithers_schema_migrations` so the target carries the version ledger.
5. Verify counts per table; on success write a `migrated.json` marker so the
   backend resolver (§4.1) stops defaulting to SQLite. Keep the old `.db` as a
   backup unless `--keep-sqlite=false`.

Time-travel and fork are already proven on Postgres (PR #214), so migrated history
remains replayable. Output tables migrate because their DDL is regenerated from
the same Zod schemas with `dialect: "postgres"`.

### 9.2 First-launch detection: fail loud, never silently degrade

The backend resolver (§4.1) runs a migration check on every boot, in **both** the
CLI entry points and the gateway/server wiring (the gateway opens the DB too,
`apps/cli/src/index.js` gateway command). If migration is needed, it throws a
typed, actionable error rather than crashing cryptically later or silently
degrading onto SQLite.

Detection has two triggers:

1. **Backend mismatch.** A legacy `.smithers/smithers.db` exists with run data and
   no `migrated.json`, but the resolved backend is `pglite`/`postgres` (the new
   default). The user has data in SQLite that this version will not read.
2. **Schema incompatibility.** The store opens, but its
   `_smithers_schema_migrations` head is older than the code's required version in
   a way the runtime cannot satisfy in place.

Both raise a `SmithersError` with code `SMITHERS_MIGRATION_REQUIRED` (new code in
`packages/errors`) so it is catchable and renders cleanly in the CLI, the gateway
log, and `apps/smithers`. The message names the file, the run count, and the exact
next command:

```
SMITHERS_MIGRATION_REQUIRED: Found an existing SQLite store at
  .smithers/smithers.db (142 runs, schema v0016) but this version uses a
  PGlite backend. Your run history will not be visible until you migrate.

  Migrate it:        smithers migrate
  Or keep SQLite:    smithers <cmd> --backend sqlite   (or backend:"sqlite" in smithers.config.ts)
```

This honors decision 4 (no silent migration: a large or precious store is never
touched unattended) **and** fails loud (no silent fallback to a backend the user
did not ask for). The explicit `--backend sqlite` / config opt-out is the escape
hatch for users who want to stay on SQLite without migrating; it suppresses the
error by making the resolved backend match the store. The check is skipped only
when the store is empty (fresh `.smithers/`) or `migrated.json` confirms a prior
migration.

### 9.3 Client replica migration

Clients do not run DDL. When the server `schema_signature` / `schemaVersion`
changes (including the first move to Postgres), `persistedCollectionOptions`
clears the local SQLite copy and re-syncs cold. This is cheap because persisted
collections hold only small rows; large outputs/diffs were never persisted.

### 9.4 Rollback

`--keep-sqlite` (default on) leaves the old file intact. Reverting is pointing the
backend resolver back at SQLite and deleting `migrated.json`. The migration is
copy-only and never mutates the source.

---

## 10. Auth and security

- **Gateway source** keeps the existing scope model
  (`packages/gateway/src/auth/scopes.ts`): `run:read/write/admin`,
  `approval:submit`, `signal:submit`, `cron:*`, `observability:read`; token/jwt/
  trusted-proxy auth.
- **Electric source** maps those scopes onto shape access in the
  smithers-electric-proxy. `run:read` gates read shapes; writes never use shapes.
  The proxy validates and fills the `where` template (run/workspace scoping),
  enforces user-private predicates where applicable, rate-limits shape opens, and
  strips `Authorization` before forwarding to Electric. This mirrors plue's proxy
  (`internal/electric/auth.go`, `shapes.go`) one-for-one against `_smithers_*`.
- **Writes** are always authenticated through the gateway/RPC + write-endpoint
  path, so audit and backpressure stay centralized regardless of sync source.

---

## 11. Risks and open questions

1. **PGlite as an Electric source (decided: don't).** Electric needs Postgres
   logical replication slots; embedded single-connection PGlite almost certainly
   cannot serve them. Confirmed-enough to base decision 1 on it. If a future
   PGlite gains logical replication, local could optionally move to Electric, but
   the design does not depend on it. Action: verify against current PGlite before
   any local-Electric work.
2. **Bundle size.** SQLite-WASM in the web PWA adds weight (smaller than PGlite's
   ~3 MB, but non-trivial). Mitigate by lazy-loading the persistence adapter and
   keeping large rows on-demand.
3. **Two un-finished PR #286 edges** must land as part of §5.2/§5.6: per-collection
   error surfacing and the run-tree hook swap. They are called out so they are not
   forgotten under the persistence work.
4. **Schema coupling to clients.** Cold re-sync on every server schema bump is
   simple but can be heavy for very large run histories. Acceptable because
   persisted collections exclude large blobs; revisit with incremental schema
   reconciliation only if re-sync cost becomes real.
5. **plue divergence (accepted).** Keeping plue's product schema separate means two
   shape catalogs and two proxies long-term. Accepted per decision 2; convergence
   stays a future option, not a commitment.
6. **Conflict handling for `_smithers_docs`.** Last-write-wins is fine for tickets;
   if collaborative editing of specs becomes a goal, this needs CRDT-style merge,
   out of scope here.
7. **Logical replication in cloud Postgres.** Requires `wal_level=logical` and a
   publication; some managed Postgres tiers gate this. Document as a deploy
   prerequisite.

---

## 12. Phased rollout

Each phase is independently shippable and leaves the stack green.

1. **Land PR #286** (TanStack DB over gateway transport, in-memory). Already open.
2. **Client SQLite persistence.** Wrap collections in `persistedCollectionOptions`;
   add web (SQLite-WASM/OPFS) and native (bun:sqlite) adapters; wire
   `schemaVersion`. Close PR #286's two edges. No backend change yet; this alone
   delivers warm reload + offline reads.
3. **PGlite as local backend.** `openSmithersBackend` + `--backend`; default
   PGlite for fresh dirs; Postgres versioned migration runner.
4. **`smithers migrate`.** One-shot copy + first-launch detection.
5. **Unify writes** onto optimistic transactions (gateway commit path).
6. **`_smithers_docs` + file sync.** Watcher, table, `tickets` collection, client
   materializer.
7. **Electric cloud source.** smithers-electric-proxy, shape catalog, Electric
   mutation commit (txid), `createElectricCollection`, cloud Postgres logical
   replication. `apps/smithers` selects the source from `backendStore`.

Phases 2–6 ship value with zero cloud/Electric work. Phase 7 is the only piece
that needs new infra.

## 13. Testing strategy

- **Dialect parity** (exists): the PG suites in `packages/db` and `packages/engine`
  run against embedded PGlite by default and real Postgres via
  `SMITHERS_TEST_PG_URL`. Extend to the new migration runner and `smithers migrate`
  round-trip (copy a seeded SQLite store, assert row-for-row equality and a
  replayable run).
- **Migration detection**: booting against a legacy SQLite store with the default
  backend throws `SMITHERS_MIGRATION_REQUIRED` carrying the actionable message
  (file, run count, schema version, next command); `--backend sqlite` and a
  present `migrated.json` both suppress it; a fresh `.smithers/` never triggers it.
  The same assertion runs for the gateway/server boot path, not just the CLI.
- **Persistence**: collection rehydrates from SQLite after reload; `schemaVersion`
  bump clears and re-syncs; large blobs stay on-demand.
- **Source parity**: the same gateway-react hook tests run against both the gateway
  `SyncSource` and a fake Electric `SyncSource`, proving UIs are source-agnostic.
- **Writes**: optimistic mutation shows instantly, `$synced` flips on confirm,
  rollback on error; Electric txid-matching against a real proxy fixture.
- **e2e** (real backend, no mocks, per repo policy): `apps/smithers` against a real
  local gateway over PGlite, and against a real Electric + proxy + Postgres
  fixture for the cloud path.

---

## Appendix: key source references

- Dialect seam: `packages/db/src/dialect.js`; PG init:
  `packages/db/src/schema-migrations.js:519`; PG API:
  `packages/smithers/src/create.js:481`.
- Gateway transport + bridge: `packages/server/src/gateway.js:2409`;
  scopes: `packages/gateway/src/auth/scopes.ts`.
- PR #286 collections: `packages/gateway-client/src/sync/createGatewayCollection.ts`,
  `gatewayCollectionDefs.ts`; react hooks: `packages/gateway-react/src/sync/`.
- DiffBundle: `packages/engine/src/effect/DiffBundle.ts`; diff route:
  `packages/server/src/gatewayRoutes/getNodeDiff.js`.
- plue Electric reference: `../plue/internal/electric/{proxy,auth,shapes}.go`,
  `../plue/cmd/electric-proxy/main.go`.
- Prior specs: `gateway-extensions-sync-backplane.md`, `smithers-sync-sdk.md`,
  `smithers-gateway-sdk-migration.md`.
