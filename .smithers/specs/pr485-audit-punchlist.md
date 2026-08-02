# PR #485 audit punch list (10 confirmed findings — fix ALL)

Adversarially-verified findings from the 3-lens Fable audit of the integrate
branch. Every item below was CONFIRMED against the code. Fix them all in this
worktree. No mocks; keep repo conventions (one export per file, DI seams).

## Runtime defects (fix first)

### 1. Electric provider dead in browser ESM bundles (major)
`packages/gateway-client/src/data/smithersElectricCollectionOptions.ts`
`runtimeRequire()` probes import.meta.require (bun-only), globalThis.require,
then an eval-based require — none exist in a Vite/ESM browser build, so every
multiplayer collection creation throws; the eval is also CSP-hostile.
FIX: replace the whole runtimeRequire/loadElectricCollectionOptions mechanism
with a lazy dynamic `await import("@tanstack/electric-db-collection")` (async
loader; the package is already a hard dependency). Keep the local-mode import
boundary intact (tests/data/local-import-boundary.test.ts must still pass —
dynamic import satisfies it). Restructure the multiplayer collection creation
path to be async where needed, or preload the module once at provider init
when mode.kind === "multiplayer". Add a test that the multiplayer path works
WITHOUT any `require` global (e.g. delete/shadow globalThis.require and
import.meta.require in the test, or assert the module contains no `require(`
probe — prefer a behavioral test constructing a multiplayer collection under
`--conditions=browser`-like constraints as far as bun allows).

### 2. SSE invalidation names disagree server↔client (major)
Server (`packages/server/src/gateway.js` apiMutationCollections ~1412,
apiCollectionsForGatewayEvent ~1440) emits: runs, run_events, nodes,
node_outputs, approvals, crons, tickets, docs. Client `invalidationPrefixes`
(`packages/gateway-client/src/data/createSmithersCollections.ts` ~62) handles
'events' (never sent) but NOT 'run_events'/'node_outputs' → they hit the
`default: [["smithers"]]` catch-all → EVERY change frame invalidates ALL
collections (refetch storm; targeted invalidation is dead code).
FIX: create ONE shared constant module in `packages/gateway` (e.g.
`src/api/apiCollectionNames.ts`, one export) listing the canonical collection
names the server may emit; server imports it (or stays aligned by test);
client maps every name specifically: run_events → events/runTree prefixes,
node_outputs → runTree/nodes prefixes, nodes → runTree/nodes. Remove the
unreachable 'events' case or keep it as an alias. ADD A TEST asserting every
server-emittable name resolves to a specific prefix set (fail the test if any
name falls through to the root catch-all).

## Test-honesty gaps (make the spec's acceptance real)

### 3. Vacuous SSE coalescing test (major)
`packages/server/tests/gateway-domain-api.test.ts` lines ~390-419: collector
stops at `frames.length < 3`, then asserts `< 5` (true by construction; also
passes with zero frames). FIX: fire the burst of 5 writes inside one coalesce
window, collect ALL frames until quiescent (no new change frame for >
3×API_STREAM_COALESCE_MS), then assert `frames.length >= 1 && frames.length
< 5` and that some frame's collections include 'runs'.

### 4. No slow-consumer test for the per-connection SSE bound (major)
`enqueueApiStreamText` (queue >= API_STREAM_OUTBOUND_QUEUE_LIMIT or bytes >
API_STREAM_OUTBOUND_BYTES → clear queue + needsReset → 'reset' event) and
`drainApiStreamSubscriber` have ZERO coverage. FIX: add a test with a stalled
reader (never read / tiny recv window), push enough invalidations to exceed
the queue limit, assert subscriber queue/bytes stay bounded (white-box is
acceptable here, mirroring the existing replay-ring assertions), then resume
reading and assert a 'reset' event arrives followed by fresh frames.

### 5. Tautological Electric row-parity test (major)
`packages/gateway-client/tests/data/electric-row-parity.test.ts` asserts
f(x).toEqual(f(x)) for 9/10 collections (mapSmithersElectricRow passthrough →
serializeXRow). FIX: make the parity real — seed a real SmithersDb (pglite),
produce each row via the /v1/api serializer path AND independently via a raw
query of the shape's table run through mapSmithersElectricRow, assert deep
equality. Keep the 'nodes' unit case (real mapping logic).

### 6. Events collection unbounded (major)
Local mode bounds only the fetch limit (1024); Electric mode syncs the full
events shape with NO row cap — a >1024-event run grows unbounded TODAY.
FIX: enforce a real ring in the collection layer (evict oldest beyond
maxRows=1024 on both providers — e.g. wrap the collection options' sync/write
path or apply a bounded view), and ADD A TEST seeding >1024 events against a
real gateway asserting collection size <= 1024 with most-recent retained.
Also fix the stale `useGatewayRunEvents` docstring in
`packages/gateway-react/src/useGatewayRunEvents.ts` (~20-27): it describes
streamRunEventsResilient + RUN_HEARTBEAT_ROW_KEY mechanics that are not how
this hook works now (invalidate→refetch / Electric shape; heartbeats filtered
in a useMemo).

### 7. Electric parity suite covers only crons (major)
Spec M3 acceptance says the M2 provider-parity suite runs UNCHANGED over
Electric. FIX: extract the parity assertions into one shared parameterized
function (provider fixture: local-sqlite, local-pglite, electric) and run the
SAME body over all, extending coverage beyond crons to at least runs, events,
and approvals (reads + optimistic write/confirm/rollback where the collection
supports writes). Electric leg stays env-gated (SMITHERS_TEST_ELECTRIC=1)
with a loud named skip.

## Hygiene

### 8. Eval suites mandate the retired API (major)
`evals/suites/authoring-misc/cases.jsonl` (~51-58),
`evals/suites/knowledge-gateway/cases.jsonl` (~311-346),
`evals/_inventory/curated-tasks.jsonl`, `evals/_inventory/generated/
ELECTRIC_CLIENT_SYNC.jsonl`, coverage-features.json: rubrics demand
createGatewayCollection/electricCollectionDefs/SyncProvider/
createGatewayPersistence etc. FIX: rewrite these cases against the new
surface (createSmithersCollections, WorkspaceMode, /v1/api + SSE
invalidation, electric-proxy multiplayer) or delete cases with no new-surface
equivalent; regenerate the inventory/coverage artifacts the repo generates
(check evals/ README/scripts for the regen command).

### 9. Coverage tickets target deleted files (minor)
`.smithers/tickets/smithers/cov-23…`, cov-26, cov-27, cov-28 (epic 0052)
point at deleted sync files. FIX: edit each ticket: mark obsolete/retargeted
with a note naming the replacement surface (SmithersDataClient SSE
reconnect/auth branches, invalidation re-pull) or close them per the ticket
conventions used in that directory.

### 10. Dead duplicate gatewayKeys module (minor)
`packages/gateway-client/src/sync/gatewayKeys.ts` has zero importers and an
incompatible key shape vs the barrel-exported data/gatewayKeys.ts. FIX:
delete it; audit sync/SyncKey.ts + sync/SyncBackoff.ts — keep only what the
new stack imports (delete orphans and their barrel exports if any).

## Gate (all must pass before you finish)
- pnpm --filter @smthrs/gateway-client typecheck+test
- pnpm --filter @smthrs/gateway-react typecheck+test
- pnpm --filter @smthrs/server typecheck+test
- pnpm --filter @smthrs/gateway typecheck+test
- root `pnpm typecheck`
- If evals regen tooling exists, run it; if docs mention changed APIs run
  `pnpm docs:llms`.
Do NOT commit or push — the orchestrator commits.
