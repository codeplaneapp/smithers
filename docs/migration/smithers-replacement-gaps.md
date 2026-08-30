# Smithers engine-replacement gap analysis

The maintainer's question: **what are we missing to truly support replacing the
internal engine in smithers (`~/smithers`, read-only reference) with the flows
engine?** This page re-verifies the pre-hardening audit ledger against the
current tree — after the issues fix wave and the round-1 hardening wave both
landed — and closes with a migration sequence, the injected-seam list, and
an honest "not soon" list. Statuses cite current source; smithers-side line
references come from the audit's partial reads (`engine.js` resume/claim
~7161–7230, `adapter.js` `claimRunForResume` ~1722, `insertEventWithNextSeq`
~3514, attempts ~2252–2340) and are directional, not pinned.

Companion pages: [implementation-status](implementation-status.md) for the
authoritative per-area status table. Sections below that route engine policy
to a "plugin" predate the bounded `@smthrs/plugin` cell-host kernel. That
kernel dispatches configuration and the hooks owned by `@smthrs/agent`;
it does not provide engine-wide lifecycle seams. Those remain injected services
or constructor options — see [design decisions](design-decisions.md).

## Ledger re-verification

| # | Audit area | Pre-hardening status | Status now |
| --- | --- | --- | --- |
| 1 | Waiting-reason taxonomy | partial | **closed** |
| 2 | Fenced claim + owner liveness | fencing only; liveness missing | **closed** (lease/heartbeat, lease-expiry default) |
| 3 | Journal append fencing | missing | **closed** |
| 4 | Pause / cancel / hijack with attribution | missing | **partial** — cancel closed, pause = park, hijack + attribution missing |
| 5 | Continue-as-new lineage | missing | **partial** — lineage edge closed, `Continued` terminal missing |
| 6 | Checkpoints / worktree lanes | partial | **still missing** (storage primitives exist; the host capability and trigger seam do not) |
| 7 | Quota park / wake | missing | **partial** — store side closed, wake driver missing |
| 8 | Supervisor sweep | missing | **closed** — shipped inside engine-store's run driver; no separate `Supervisor` layer is planned |
| 9 | Fault-suite harness | partial | **closed as harness**; case parity accretes with features |

### 1. Waiting-reason taxonomy — closed

Closed by the waiting columns in the authoritative `0001_initial` schema.
`DurableEngineState.park` / `wake` / `waiting` / `waitingRuns` round-trip
`{ reason, wakeAt?, token? }` with `approval | event | timer | quota |
released` reasons — `released` (issue #39) marks a run whose owning process
released it without settling it (shutdown, heartbeat self-interrupt); it has
no held lease and no `wakeAt`, so a sweeper must scan for the reason itself —
an index on `(waiting_reason, waiting_wake_at_ms)` built for a sweeper query,
and `WaitingReason.test.ts` covering per-reason round-trips, non-owner park
rejection, and the due-quota-run query. This is exactly the audit's "done"
definition. Smithers' inline per-reason states in `engine.js` (pinned by
`e2e/faults` restart-waiting-approval/event/timer) are replaced by the one open
taxonomy, per the pluggability rule.

The production park path reaches the full taxonomy through
`FlowRuntime.annotateWaiting` (issue #31): a flow declares
`{ reason, wakeAt?, token? }` immediately before suspending and the driver
parks the run with exactly that payload (`AnnotatedWaiting.test.ts` pins the
approval-with-token and due-quota sweeps end-to-end); without an annotation the
driver derives `timer`/`event` from durable clock state.

### 2. Fenced claim and owner liveness — closed, one caveat

`RunStore.claimAndOwn` (PR #7) carries the fence; the hardening wave added the
lease half the audit called missing: `heartbeat_at_ms` with a 30s staleness
window (`packages/run-store/src/RunStore.ts:334`), stale-owner steal inside the
claim's `WHERE` clause (`RunStore.ts:637,692,818`), and a fenced `heartbeat`
operation. No pid probing anywhere — the audit's explicit rejection of
smithers' pid-verified `runState` (`packages/db/src/runState`) holds. Fault
coverage: `FaultMatrix.test.ts` proves fence loss at heartbeat, `attempts.put`,
and `attempts.finish` leaves exactly one durable completion.

**Caveat:** the pid half is closed — `EngineStore` mints owner identity through
the `OwnerIdentity` port, whose default draws from `Random` where the platform
has no process, so the store now meets the browser-host requirement (see
[implementation-status](implementation-status.md) cautions). Cross-host liveness
is closed too: `EngineStore.Options.isAlive` is optional and defaults to
`Ownership.leaseLiveness(Ownership.heartbeatStaleAfter)`, which answers from the
lease alone, so a fresh process reclaims a hard-killed owner's runs with no
application code. The steal it admits carries `lease-expired` evidence that
`RunStore.steal` re-verifies against the row in the same write. A deployment
that can say more supplies its own check and refuses the takeover for longer.
Such a check is a pid probe guarded by `Ownership.sameHostIncarnation`, or an
orchestrator's report of pod liveness.

### 3. Journal append fencing — closed

Closed by `ae8a41d` ("fence run-scoped writes on ownership and split the lossy
emit channel") plus the issue-#3 `emitDurable` that allocates the canonical
sequence inside the write transaction. `JournalFencing.test.ts` and the
`FaultMatrix` claim-takeover case ("owner B claims while owner A is executing,
and A's later writes cannot corrupt state") prove the zombie-owner invariant
the audit demanded — temporal's shard fencing expressed as a `WHERE` clause,
as prescribed. Smithers' `insertEventWithNextSeq` (~3514) has no fencing at
all; flows is now strictly ahead here.

### 4. Pause / cancel / hijack with attribution — partial

- **Cancel: closed.** `cancelRequested` is a durable unfenced request on the
  run row, observed by guarded transitions inside the CAS
  (`RunStore.ts:250,871`) — a stronger shape than smithers' cancel.
- **Pause: effectively available** as `park(reason)` over §1's taxonomy, but
  there is no user-facing pause verb and, critically, **no attribution** —
  no actor/why fields on the park or the control event.
- **Hijack: missing**, by design deferred to an injected seam. A former,
  speculative engine lifecycle catalog named `runControl`, but that hook was
  removed and the blessed cell-host catalog neither exposes nor dispatches it.
  No service owns this policy yet.

Done = a small `RunControl` service that journals an attributed control event
(actor, reason) and flips `DurableEngineState`, with hijack shipping as an
alternative `RunControl` implementation provided by a `Layer`. Smithers evidence: pause and hijack fault cases plus
who/why columns on the run row.

### 5. Continue-as-new lineage — partial

`flows_runs.parent_run_id` landed (`7aa944d`; `RunStore.ts:104–120`), and the
docstring explicitly names it "the lineage edge a fork, rewind, or
continue-as-new child" records. `SqlTimeTravelStore.createFork` writes it.
Missing: a `Continued` terminal status/journal event that closes the parent
run, and automatic lineage recording from ordinary engine execution (listed
under planned integration). Done = `Continued` terminal + a restart-lineage
fault case, matching smithers' continue-as-new and fork fault pins.

### 6. Host checkpoints and worktree lanes — still missing

The largest remaining functional gap versus smithers' Tier-1 durability
snapshots (`snapshot-hook`), restore/revert/rewind, and `smithers worktree`
lanes. What exists on our side: the time-travel package's fork/rewind/replay
over stored state, `Jj` in `@smthrs/jj`, and `StepBoundary`'s
filesystem-backed production layer for read-set measurement and output
materialization. The former speculative `checkpoint` hook was removed with the
unowned engine lifecycle catalog; the blessed cell-host plugin catalog does not
expose or dispatch it. What is missing: a layer-gated `Checkpoint` host
capability (`makeNoop` for browser) that actually snapshots
agent-session/worktree state at step boundaries, an injected trigger policy,
whole-tree change detection with jj, and any worktree-lane lifecycle. Done =
the owning runtime invokes that capability at step boundaries through its
explicit injected policy, not through an engine-wide plugin hook.

### 7. Quota park / wake — partial

The store half is done and was designed for exactly this: `quota` is a
first-class waiting reason, and `waitingRuns` answers "which quota-parked runs
are due" (`WHERE waiting_reason = 'quota' AND waiting_wake_at_ms <= now`,
covered by a test). Durable clock rows with restart re-arming also already
ship. Missing: the classifier that turns a provider quota error into a park
with `wakeAt` and a wake via the durable clock. Done = that classifier as an
injected service at the wait/wake seam, with one park-then-wake fault case;
nothing new in core.

### 8. Supervisor sweep — closed, inside the run driver

The sweep shipped. It is not a `Supervisor` layer: it runs in
`packages/engine-store/src/internal/RunDriver.ts`, on the heartbeat cadence,
in every process that drives runs. Four behaviours make up the contract the
audit asked for:

- **Stale-running re-drive** (issue #53). `sweepStaleRunning` enumerates rows
  still marked `running` whose heartbeat fell outside
  `Ownership.heartbeatStaleAfter` and re-drives them through the ordinary
  claim/steal path, so a hard-killed owner (SIGKILL, OOM) no longer strands
  its run. The batch is capped per tick, oldest heartbeat first (issue #79).
- **Released-row scan** (issues #67, #68). A run parked with reason
  `released` has neither a held lease nor a `wakeAt`, so scanning expired
  leases and due wakes alone would strand it. `sweepCancelRequested` asks
  `waitingRuns` for exactly the actionable rows — reason `released`, plus a
  `cancelRequested` filter predicate — instead of scanning every parked run.
- **Due wakes and cancel delivery.** The same sweep wakes parked runs whose
  cancellation was durably requested, and durable clock rows re-arm on
  restart, so a park always has something that comes back for it.
- **Unregistered-flow warning** (issue #62). A wake for a flow this process
  never registered logs a once-per-run structured warning and leaves the row
  parked for a worker that does register it, rather than no-oping silently.

**No separate `Supervisor` layer is planned** (maintainer decision,
2026-08-13). Resumption requires a live process with the flows registered —
a driver has to hold the body to re-drive it — so a sweeper that owns no
registrations can only move a row from one parked state to another.
No-process-no-progress is the correct contract for a library: the process
that can make progress is the one that sweeps. Smithers'
`apps/cli/src/supervisor.js` claim-by-proxy process is replaced by that, and
the audit's explicit rejection of a separate CLI app stands.

### 9. Fault-suite harness — closed as harness

The P0 harness the audit demanded exists: `Notifying.wrap`/`layer`
(`@smthrs/journal/test/Notifying`)
injects interstitial crashes and fence loss around any Effect service, and
`FaultMatrix.test.ts` (9 it-blocks: 7 fault injections — 3 interstitial
crashes, 4 fence losses — plus 2 tests of the `Notifying` wrapper itself)
plus `DurableWaitingRestart`, `WaitingReason`, and `Ownership` tests pin
crash/restart invariants deterministically — the bazel `GraphTester` shape.
Parity with smithers' `e2e/faults` enumeration is still far off, and not
only where the underlying feature is missing (no pause, hijack, quota-wake,
or continue-as-new lineage cases yet): holes remain where the feature
already ships — journal payload redaction (smithers case 22, issue #46) has no
fault case either, and of the memory-budget / soak assertions (cases 16/28,
issue #50) only case 28 (the long-wall-clock RSS soak) remains uncovered:
case 16's N-subscriber bounded-memory/consistency assertions ship in
`packages/sync/test/ServerSoak.test.ts` (identical frames to every concurrent
subscriber, per-subscriber stream release, bounded retained heap). And
the sandbox health taxonomy (case 02, issue #49) now ships as a host
primitive (`@smthrs/sandbox`'s `SandboxHealth` probe) but has no engine-level fault case yet. Cases
accrete as §§4–7 and those issues land; the harness itself is no longer a
gap.

## New gaps the audit did not list

1. **The engine-wide lifecycle hook catalog was never dispatched, and is now
   gone; the bounded cell-host plugin kernel remains.** `@smthrs/plugin`
   originally shipped (`985adb5`) with a speculative full catalog, but no
   engine call site dispatched its run, step, retry, cache, wait, checkpoint,
   or journal hooks, so those declarations were removed rather than advertised.
   The package now resolves the configuration lifecycle and only the additional
   hooks a host owns and dispatches; `@smthrs/agent` supplies
   `cellRegistry`, `cellFlows`, and `cellModelRequest`. Pause attribution,
   hijack, quota, and checkpoints still need seams as injected services and
   constructor options at the sites that own them, not as a lifecycle registry.
2. **No packaged production layer — half closed.** `@smthrs/flows/NodeRuntime`
   composes database + migrations + journal + run/attempt/cache stores +
   durable engine state + workspace + artifact store + engine into one
   importable layer, with `registerFlows` as the final startup phase
   (`packages/flows/src/NodeRuntime.ts`). That is the storage-and-engine half
   of the cutover artifact. The host half is not in it: the module installs
   neither `NodeHost.layer` nor the guarded `HostServices` kernel, so `Jj`,
   Effect `FileSystem`, and Effect `Crypto` remain requirements the embedder
   supplies, and `StepBoundary` and `WorkspaceSandbox` are passed in as
   arguments (`NodeRuntime.ts:105-121,128-131`). It also installs no signal
   handlers. Smithers can adopt the storage and engine wiring as a dependency;
   it still writes its own host and kernel composition. Its application-source
   consumers in this repository are `examples/src/durable-layer.ts` and the
   production control executor in `packages/cli/src/NodeControl.ts`, and
   `packages/flows/test/NodeRuntime.test.ts` directly gates the module over a
   real SQLite file.
3. **Handler re-registration on restart.** Flow registrations are in-memory; a
   restarted process must re-register before driving stored runs. Smithers'
   resume path assumes the engine can pick up any persisted run; the cutover
   shim must guarantee registration-before-resume.
4. **SQLite-only dialect parity (accepted gap, issue #78).** flows ships one
   `SqlClient` backend behind `DurableWriter`: `NodeDatabase` over
   `@effect/sql-sqlite-node`. Browser package roots expose the driver-neutral
   contract, but no browser SQL client layer ships here. Every package's migration set
   (`packages/{journal,run-store,step-cache,engine-store}/src/Migrations.ts`)
   is SQLite-flavoured DDL. Smithers,
   however, supports PGlite and Postgres (`packages/db/src/ensure.js` and
   `adapter.js` branch on `dialect === 'postgres'`, and `smithers migrate`
   exists to move a workspace onto them), so stage 1 below is a *SQLite-only*
   win: a workspace already on PGlite/Postgres cannot take it as written.

   What has landed: write-retry classification is no longer dialect-blind.
   `DurableWriter.make` accepts any `SqlClient`, and the classifier now recognises
   the Postgres transient vocabulary (`40001`, `40P01`, `55P03`, plus the
   PGlite text forms) alongside the SQLite codes, and `fromSqlError` maps them
   to the same stable `busy` category — so a hand-supplied `PgClient` gets the
   fencing/retry behaviour the ledger claims, rather than silently getting
   none.

   What remains, and is **accepted as a known gap** rather than scheduled
   ahead of the cutover: no `PgDatabase`/`PGliteDatabase` layer, and a
   dialect-portable migration ladder. The plan, in order, when a pg-backed
   workspace actually needs stage 1: (i) add `packages/database/src/pg/` and
   `packages/database/src/pglite/` layers over `@effect/sql-pg` /
   `@effect/sql-pglite` — thin, and the retry seam is already dialect-blind;
   (ii) split the ladder's SQLite-specific DDL (`INTEGER PRIMARY KEY`,
   `INSERT OR IGNORE`, `AUTOINCREMENT`) behind a dialect parameter on
   `Migrations.run`, **and port the statements that live outside the ladder
   entirely** — `DurableEngineState.make` creates engine-store-owned schema
   at construction (issues #40/#41/#79/#81), inventoried in
   `packages/engine-store/src/internal/EngineStateSchema.ts` with the
   dialects each is known to accept. Of those, `flows_run_parents_gc` is the
   blocker: its inline `BEGIN...END` trigger body is SQLite-exclusive and
   needs a `CREATE FUNCTION ... RETURNS trigger` plus
   `CREATE TRIGGER ... FOR EACH ROW EXECUTE FUNCTION` on Postgres. Everything
   in `make` is piped through `Effect.orDie`, so an unported statement is a
   layer-construction defect, not a recoverable error. A test diffs the
   catalog across `make` against that inventory, so newly added out-of-ladder
   DDL cannot escape this list (issue #92); (iii) run the existing journal and engine-store suites
   against the PGlite layer as a second backend in CI, which is the only
   honest proof of parity. Until then the correct advice is explicit: migrate
   a pg-backed smithers workspace to flows only after (i)–(iii), or keep it on
   `adapter.js` storage through stage 1.

## (a) Recommended migration sequence

Move storage first, loop second, operations third — each stage runs under the
existing smithers CLI unchanged.

1. **Journal + run rows under smithers (shim: adapter-compat layer).** Replace
   `adapter.js`'s `insertEventWithNextSeq`, `claimRunForResume`, and attempt
   tables with `@flows` Journal/RunStore/AttemptStore behind a compat module
   that preserves `adapter.js`'s call signatures. flows is strictly stronger
   here (fencing, in-transaction seq, lease steal), so for a SQLite-backed
   workspace this is a pure win and de-risks everything after; a pg-backed one
   is blocked on new gap 4. Shims needed: an event-shape translator
   (smithers event rows ↔ journal producer events) and a one-shot data
   migration for live runs.
2. **Engine loop for new runs only (shim: dual-engine routing).** New runs
   execute on `Engine.FlowEngine` + `DurableEngineState`; existing runs finish
   on the old loop. The storage-and-engine half of the packaged production
   layer this needs now exists (`@smthrs/flows/NodeRuntime`), and the
   registration-before-resume guarantee is that layer's `registerFlows` phase;
   Smithers still supplies the host services and kernel around it. Waiting
   states route through the taxonomy instead of `engine.js`'s inline cases.
3. **RunControl (retire `supervisor.js`, `pause`, `cancel` paths).** The
   claim-by-proxy process is already replaced by the run driver's own sweep
   (§8), so this stage is `RunControl`: pause/cancel with attribution. The
   smithers CLI verbs become thin RPC over the layer.
4. **Time travel + checkpoints last.** `snapshot-hook`, restore/revert/rewind,
   and worktree lanes move onto the `Checkpoint` capability and the
   time-travel stores. Last because it has the largest missing surface (§6)
   and the least crash-safety risk while both systems coexist.

## (b) Gaps that belong at an injected seam, not in core

These stay out of the executor. Some had names in the removed engine lifecycle
catalog, but they are not hooks callers can register today. Read each as the
service or constructor option that must own that decision:

- **Hijack** — an alternative `RunControl` implementation (§4).
- **Quota park/wake** — an injected error classifier at the wait/wake seam,
  plus the durable clock (§7).
- **Checkpoint triggering** — an injected policy decides when; core only
  provides the host capability (§6).
- **Provider-specific error classification** (quota vs transient vs fatal) —
  `classifyError` / `resolveRetry`, keeping smithers' hard-won provider quirks
  out of the loop.
- **Approval UX** — `waitStart(reason: "approval")` plus an external resolver;
  core only parks and wakes.

Core keeps: the taxonomy, fencing, leases, `RunControl`'s journaled verbs, the
supervisor, and the `Checkpoint` capability itself.

## (c) Not soon — honest list

- **Worktree-lane parity** (`smithers worktree` reclaim, per-lane isolation):
  depends on §6 plus jj lifecycle design; no near-term path.
- **Cross-run hermetic caching / output materialization** and the static
  planner API: planned, not started.
- **Cross-process event-driven wake**: the in-process `WakeBus` completes
  `resumeSignal` today; polling remains the fallback across processes.
- **Edge/serverless deployment parity** (runnable Cloudflare engine-store,
  fully durable Vercel deferreds/clocks).
- **Smithers' UI-adjacent engine features** (live gateway mirroring, eval
  suites, GEPA optimization): out of engine scope entirely; they stay in
  smithers and consume the engine's sync/journal streams.

## Verdict

Of the audit's nine areas, five are fully closed (taxonomy, liveness, journal
fencing, fault harness, supervisor sweep), three are partial with the hard
half done (control verbs, lineage, quota), and one remains (checkpoints). The
durability core is at or above smithers parity; what stands between here and
cutover is integration, not invariants: put services behind the remaining
seams, package the production layer, and ship the small `RunControl` layer,
then begin stage 1 of the migration immediately — for a SQLite-backed
workspace the storage swap is already a strict upgrade. For a PGlite- or
Postgres-backed one it is not yet available at all; that is new gap 4, an
accepted gap with a written plan, not an oversight.
