# POC findings: can smithers-flows back smithers' durability?

Branch: `flows-durability-poc` (on top of origin/main `d41903b54`).
POC package: `packages/flows-durability-poc` — vendored flows wired from `./vendor/smithers-flows` (never committed).

## Verdict

**A full durability cutover to smithers-flows is NOT viable today.** The slice that
exists in SQL (runs, attempts, journal events, cache) is real and composable — the
composition question has a good answer — but three things block the cutover:

1. **Claim/activate is strictly two-phase and claimant-becomes-owner** (smithersai/smithers#1451).
   Smithers' claim is a single-phase CAS that observably transfers `runtime_owner_id`,
   and the supervisor claims by proxy while the engine resumes under a different owner.
   Flows-backed variants of fault cases 01/06 fail on exactly this.
2. **`DurableEngineState` is memory-only** (#1452). Durable approvals, event waits, and
   timers (fault cases 03/04/05) have no flows SQL home.
3. **`SqlTimeTravelStore.createFork` does not produce an executable fork** (#1456) and
   `flows_runs` has no lineage column (cases 07/12/24 analogs).

Underneath those, a layer of schema-fit issues (#1453, #1454, #1455) would each need
resolution even after the blockers: 17 run columns have no home outside `state_json`,
the fenced CAS can't guard on cancel-requested, the journal's seq clock lives in
process memory, and AttemptStore's vocabulary/semantics diverge in five places.

## Composition approach (step 1)

**Chose option (b)+(a):** a new workspace package `packages/flows-durability-poc` with
its own `effect@4.0.0-beta.102` dependency (pnpm parent-selector overrides carve it out
of the repo-wide `effect: 3.21.4` pin; both the package and the vendored `@flows/*`
resolve the SAME effect-4 store path, so TypeIds match) and a plain-async-JS boundary —
no Effect value crosses the v3/v4 line.

**Can flows share smithers' SqlClient/transaction? Empirically: YES, but not the way
the question assumes.**

- Smithers' "SqlClient" is a hand-rolled effect-**v3** wrapper over a raw `bun:sqlite`
  handle (`packages/db/src/sql-message-storage.js:772`). It cannot be passed to flows'
  `Database.make` — different effect major, different TypeIds, and flows' client is
  effect-v4 `effect/unstable/sql/SqlClient`.
- Flows' shipped sqlite host is `@effect/sql-sqlite-node` (**node:sqlite**) — a second
  connection to the same file, hence a *different transaction domain*. Sharing a file
  is not sharing a transaction.
- What works: build an effect-4 `SqlClient` over the **same `bun:sqlite` handle**
  (`src/v4client.js`, mirroring smithers' v3 `SqlClient.make` pattern), and bridge
  `withTransaction` on `sqlite.inTransaction`: when smithers' adapter already holds
  `BEGIN IMMEDIATE` on the handle, flows writes join the ambient transaction instead of
  issuing a nested `BEGIN`.

Proven by `tests/composition.test.js` (6/6): flows' migration applies alongside
smithers' tables in the same file; one transaction spans `_smithers_*` and `flows_*`
tables; a rollback on either side discards both; outside an ambient transaction flows
opens its own `BEGIN IMMEDIATE`.

## What works on flows (with proof)

| SmithersDb method | Backed by | Test proof |
| --- | --- | --- |
| `insertRun`, `getRun`, `heartbeatRun`, `listStaleRunningRuns` | RunStore + shim SQL | `tests/run-ownership.test.js` 11/11 |
| `claimRunForResume`, `releaseRunResumeClaim`, `updateClaimedRun`, `completeRun` | RunStore claim/steal/activate/transitionOwned | same; CAS exclusivity, heartbeat fence, stale steal all verified |
| `insertAttempt`, `getAttempt`, `heartbeatAttempt`, `claimAttemptTerminal`, `listAttempts`, `updateAttempt` (meta-only) | AttemptStore + shim SQL | `tests/attempts.test.js` 10/10 |
| `insertEventWithNextSeq`, `getLastEventSeq`, `listEventHistory` | shim SQL on `flows_journal_events` | `tests/journal.test.js` 4/4 |
| kill+resume attempt fence end-to-end | all of the above via `FlowsBackedSmithersDb` | `tests/faults-flows-backed.test.js` case31-style 1/1 |

`FlowsBackedSmithersDb` (`src/flows-backed-db.js`) subclasses the real `SmithersDb`,
overrides the 16 methods, and falls through to the real adapter for everything else,
all over one handle.

### Where the homeless fields went (step 2/3 reports)

- `flows_runs` has no cancel attribution (5 cols), `pauseRequestedAtMs`, hijack pair,
  vcs triple, `configJson`, `parentRunId`, or workflow identity → all live in
  `state_json.smithers`. Lost: SQL queryability and **CAS participation** — `completeRun`'s
  `cancel_requested_at_ms IS NULL` guard is now read-then-write racy (#1453).
- flows' status CHECK (`pending/running/suspended/completed/failed/cancelled` + owner
  nullability) can't hold smithers' 10 statuses; waiting-*/paused map to `suspended`
  with the exact status in `state_json`. Owner must be NULL when suspended — smithers
  keeps it set.
- Attempt `step_key_digest = sha256("smithers-attempt:v1:runId:nodeId:iteration")`;
  `nodeId`/`iteration` recover only from `meta_json.smithers`. Agent meta
  (`agentResume`, `agentConversation`, …) round-trips **by name** at meta top level.
  `responseText`/`jjPointer`/`jjCwd`/`cached` live in `meta_json.smithers`, unqueryable.
  `heartbeatDataJson` → `checkpoint_json` (1 MiB cap — real agent sessions exceed it,
  test-proven). Attempt in-progress state translated `in-progress` ↔ `running` (#1455).
- Journal events: **did not use SqlJournal** — it hydrates the per-run seq clock into
  process memory and allocates there; multi-writer append would fork the clock on the
  `(run_id, seq)` PK. The shim allocates `MAX(seq)+1` inside the write transaction
  (smithers' discipline) on the flows table; concurrent two-writer test passes (#1454).

## Test results (everything that was run)

| Suite | Result |
| --- | --- |
| `bun test tests/` in packages/flows-durability-poc (composition 6, run-ownership 11, attempts 10, journal 4, faults-flows-backed 5) | **32 pass, 4 fail** — the 4 fails are the intended two-phase-claim divergence recordings |
| flows-backed case01 (real assertions, flows store) | **FAIL** at `afterClaim.runtimeOwnerId` — claim not observably owner-transferring (#1451) |
| flows-backed case06 (3 tests) | **FAIL** ×3, same assertion; the CAS exclusivity assertions within them PASS |
| flows-backed case31-style (kill + claim→activate + fenced terminal + journal) | **PASS** |
| `pnpm -C packages/db test` (baseline, original path) | 735 pass, 0 fail |
| `bun test` packages/engine (baseline, original path) | 1138 pass, 2 skip, 0 fail (first background run false-red — known bun subprocess flake; clean rerun green) |
| e2e harness + faults 01/03/04/05/06/07/31 (baseline, original path, from repo root) | 45 pass, 4 skip, **1 fail** — case07 "schema migrations declare parent_run_id" is cwd-sensitive (ENOENT from repo root; passes from `e2e/`). Filed #1457 |

Cases 03/04/05 and 07/12/24 were **not** run flows-backed: there is nothing to point
them at — flows has no SQL `DurableEngineState` (#1452) and no executable fork (#1456),
so their flows-backed failure is structural, confirmed from flows' own status doc
(`vendor/smithers-flows/docs/architecture/implementation-status.md:28,50`), not
assumed. No test was weakened, skipped, quarantined, or deleted; the 4 flows-backed
failures above are unaltered-assertion reds with explanations.

## Issues filed

(smithersai/flows has issues **disabled**; flows-library issues are filed on
smithersai/smithers with a `flows:` prefix and say so in the body.)

1. smithersai/smithers#1451 — **BLOCKER** flows claim/activate two-phase, claimant==owner: single-phase claim + claim-by-proxy unrepresentable (case01/06 reds).
2. smithersai/smithers#1452 — **BLOCKER** `DurableEngineState` memory-only: durable approvals/events/timers have no SQL home (cases 03/04/05).
3. smithersai/smithers#1453 — `flows_runs` metadata gap: 17 columns homeless in `state_json`; CAS can't guard on cancel-requested; status CHECK rejects smithers lifecycle.
4. smithersai/smithers#1454 — `SqlJournal` allocates per-run seq in process memory; multi-writer forks the clock; `emit` returns pre-durability.
5. smithersai/smithers#1455 — AttemptStore gaps: hardcoded 'running' in-progress state, first-writer-wins vs upsert, `finish()` nulls `error_json`, no unfenced patch, 1 MiB checkpoint cap.
6. smithersai/smithers#1456 — **BLOCKER** `SqlTimeTravelStore.createFork` not executable; no lineage column (cases 07/12/24).
7. smithersai/smithers#1457 — (smithers-side) e2e case07 schema-migration test is cwd-sensitive.

## What I'd do next

1. Land a single-phase `claimAndOwn` (or activate-with-distinct-owner + compensating
   restore) in flows RunStore — #1451 is the only blocker the *existing* fault suite
   exercises directly; fixing it turns case01/06 green and unlocks real case31.
2. Design the SQL `DurableEngineState` schema (deferreds + clock deadlines) alongside a
   decision on where smithers' 17 homeless run columns live — do both before more shim
   work, because the state_json side-channel is already at its usefulness limit.
3. Move journal seq allocation into SQL (or document single-writer) before any
   multi-process deployment of a flows-backed engine.
4. Only then re-run the full fault suite flows-backed, including a real
   engine-process kill (case31 proper) with an injectable adapter.
