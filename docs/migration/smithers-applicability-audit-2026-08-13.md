# Smithers applicability and defect audit — 2026-08-13

This audit asks two questions:

1. Which open issues and hard-won bug fixes in `smithersai/smithers` also apply
   to `smithersai/flows`?
2. What additional defects become visible when the Flows implementation is
   read as a whole rather than only through the existing comparison document?

The findings are written before implementation work on purpose. No production
fix is part of this audit.

## Baselines and scope

- Flows source baseline: `a9e6ce556a39f348c5410e848f2c1f6f065ebb73`
  on 2026-08-13. The worktree was already ahead of `origin/main` and had
  unrelated concurrent edits; those edits were preserved.
- Smithers history baseline: `origin/main` at
  `16490c197c98e67f4c8de122ab29a0a32bb7d7e2`. The checked-out Smithers branch
  was that commit plus two documentation/skill commits.
- Smithers had 96 open issues and 6,724 commits at the audit point.
- The Smithers tree had 9,344 tracked files, 5,917 implementation-shaped files,
  and 1,368 JS/TS/SQL files (229,612 lines including tests) in the directly
  analogous engine, scheduler, DB, driver, time-travel, agent, sandbox, VCS,
  and graph packages.
- The Flows tree had 912 tracked files and 243 TypeScript files (44,909 lines)
  under package `src` trees.

The whole Smithers tree and history were indexed and searched. Manual patch and
source review concentrated on the packages that can transfer to Flows:
`engine`, `scheduler`, `db`, `driver`, `time-travel`, `agents`, `sandbox`,
`vcs`, and `graph`, plus the CLI control/status paths around them. The entire
Flows package source inventory was scanned; lifecycle, persistence, journal,
sync, sandbox, cache, planning, and time-travel code received line-level review.
This is a whole-tree applicability audit, not a claim that every UI component
in Smithers was semantically relevant to the executor.

## Executive result

The central conclusion is that the existing
[`smithers-replacement-gaps.md`](smithers-replacement-gaps.md) overstates the
state of cancellation. Cancellation is durable as a row-level request, but its
cleanup and child-flow semantics remain process-local. A parked cancellation
can never close the scope it left behind, and a cancellation observed by a
different process does not mark the running instance as interrupted, so its
child-cancellation finalizer declines to act.

The other high-value transfers from Smithers are its lessons about bounded
history, transactional control transitions, attempt-scoped retry state,
process-tree containment, and checkpoint/worktree consistency. Flows is ahead
of Smithers in several areas—journal fencing, deterministic step keys, and
transactional run-parent edge creation—but it has real holes around those
boundaries.

The final ledger contains 22 actionable findings: 6 High, 9 Medium, and 7 Low.
Nineteen came from the primary audit; Claude Fable accepted 16 of those as
legitimate and narrowed 3 to partial findings. It rejected none. Three more
findings came from Fable's adversarial pass and were retained after direct
source validation. Thirteen additional `G-*` rows are known production/parity
gaps rather than newly discovered defects.

## Smithers issue and history applicability

All 96 open issue titles and metadata were triaged. Bodies and linked code were
then read for the lifecycle, persistence, process, retry, time-travel,
retention, and control-plane candidates. The remaining issues concern
Smithers-only UI/CLI/provider/workflow features or did not expose an additional
Flows analogue. This is the high-signal issue-level disposition:

| Smithers issue | Applicability to Flows |
| --- | --- |
| [#1496](https://github.com/smithersai/smithers/issues/1496), dead owner leaves cancel pending/orphaned | Direct lifecycle analogue: F-01, F-05; same operator symptom also motivates F-03 |
| [#1492](https://github.com/smithersai/smithers/issues/1492), `Infinity` loop cap | Does not transfer; Flows validates finite caps and uses omission as the unbounded sentinel |
| [#1500](https://github.com/smithersai/smithers/issues/1500), self-healing gap | Architectural transfer: F-16 and G-13, not a drop-in patch |
| [#1491](https://github.com/smithersai/smithers/issues/1491), unbounded logs/worktrees | Direct operational lesson: F-09, G-03, G-08, G-09 |
| [#1432](https://github.com/smithersai/smithers/issues/1432), resumed exhausted nodes replay stale errors | No exact analogue: Flows has no accepted-workflow-change/agent-chain reset; its generic retry-bound ambiguity is F-11 |
| [#1431](https://github.com/smithersai/smithers/issues/1431), parked approval lost | Future test case under G-01; Flows has no approval resolver yet |
| [#1349](https://github.com/smithersai/smithers/issues/1349), control database reaches 100GB | Direct production outcome for F-08/F-09 |
| [#1332](https://github.com/smithersai/smithers/issues/1332), orphan processes busy-loop | Process-containment lesson for F-16 and G-02 |
| [#1153](https://github.com/smithersai/smithers/issues/1153), transcript attempt scope | No transcript subsystem; only its retention lesson transfers through F-09 |
| [#1056](https://github.com/smithersai/smithers/issues/1056), force-resume split brain | Run ownership is already fenced; the same split-brain lesson remains exposed in F-14 |
| [#980](https://github.com/smithersai/smithers/issues/980), cancel attribution | Direct: F-06 and G-01 |
| [#972](https://github.com/smithersai/smithers/issues/972), durable agent/process trees | Direct lifecycle/containment design input for F-02, F-04, and G-02 |
| [#971](https://github.com/smithersai/smithers/issues/971), transactional recursive cancellation | Direct: F-02/F-04 |
| [#885](https://github.com/smithersai/smithers/issues/885), child concurrency accounting | Applies when linked child runs consume agent capacity: G-12 |
| [#584](https://github.com/smithersai/smithers/issues/584), downstream `resetNodes` expansion | Does not transfer; Flows has no corresponding mutation API |
| [#1450](https://github.com/smithersai/smithers/issues/1450), resume needs inputs again | Already avoided by persisted `RunState.payload` |
| [#1326](https://github.com/smithersai/smithers/issues/1326), local PID liveness on multiple hosts | Exact bug avoided by the injected `LivenessProbe`; probe quality still affects F-10 |

The full history scan found 2,428 fix-like commits, 517 of them in the directly
analogous core packages. Manual patch review clustered the transferable fixes
as follows:

| Smithers fix family | Flows disposition |
| --- | --- |
| Dead/cancel-pending ownership (`66166ceb`, `8cac542`) | Direct evidence for F-01/F-05 and the need for control-only terminalization |
| Process and agent containment (`d2d7f12`, `baec700`, `1b9e0e0`) | Design prior art for F-02/F-04/G-02; do not copy the process registry into the core engine unchanged |
| Transactional steer/fencing (`e0624e0`, `0d96f88`, `1ad95a0`) | Direct model for attributed control state, terminal-state outcomes, and one-transaction settlement in F-06/F-18/G-01 |
| Attempt/checkpoint/time-travel recovery (`b83378b`, `0ece235`, `d791834`, `e364005`, `71c0c94`) | Applies to the persisted phase/provenance boundaries in F-11/F-12/F-13/G-03 |
| Unbounded-loop cap (`a0b85d7`) | No current Flows defect; keep the finite-cap validation test |
| Async result/thenable normalization (`d916161`, `b2ae875`) | No current equivalent bug; retain as adapter regression-test guidance |

### Smithers' earlier Flows adapter is proof, not a drop-in implementation

Smithers previously built compatibility layers against an older Flows API:

- [`e8f1c66b`](https://github.com/smithersai/smithers/commit/e8f1c66b)
  added a 393-line run-ownership shim over the old `@flows/journal` `RunStore`
  plus 264 lines of tests;
- [`81ea2d`](https://github.com/smithersai/smithers/commit/81ea2d),
  [`7b32360`](https://github.com/smithersai/smithers/commit/7b32360), and
  [`20ed75b`](https://github.com/smithersai/smithers/commit/20ed75b) added
  attempt, journal, and `FlowsBackedSmithersDb` shims;
- [`a981e753`](https://github.com/smithersai/smithers/commit/a981e753) and
  [`ef39a385`](https://github.com/smithersai/smithers/commit/ef39a385) later
  removed/reverted that integration to recover isolation.

Those patches prove that CAS ownership, heartbeat, takeover, and fencing can
sit above Flows storage. They also show why copying them back would be wrong:
the adapter depended on superseded APIs and still lacked cancellation
attribution, pause/hijack control, VCS/config/workflow identity, and supervisor
handoff. Current Flows should absorb the protocol lessons at its public store
and engine boundaries, not resurrect `FlowsBackedSmithersDb`.

## Candidate finding ledger

The `F-*` rows are the primary audit findings. The `R-*` rows were raised by
the independent reviewer and retained after source validation. The `G-*` rows
are documented production or parity gaps rather than surprise bugs.

| ID | Initial | Final | Finding | Evidence | Fable verdict |
| --- | --- | --- | --- | --- | --- |
| F-01 | High | Medium | `interrupt()` can report success after the durable cancel write failed | Source + existing test | Legit |
| F-02 | High | High | Cross-process cancellation skips linked child cancellation | Reproduced + source-forced | Legit |
| F-03 | High | High | Cancelling a parked run never closes its retained flow scope | Reproduced + source-forced | Legit |
| F-04 | High | Medium | Cancellation has no durable recursive/subtree operation | Source | Partial: missing feature/remedy, not a standalone acute bug |
| F-05 | Medium | Medium | A cancelled parked run cannot terminalize without its flow being registered | Source | Legit |
| F-06 | Medium | Low | Cancellation records have no actor/source/reason attribution | Source + documented gap | Legit; known missing feature |
| F-07 | Medium | Medium | Durable `interruptUnsafe` is an alias of ordinary `interrupt` despite a different contract | Source | Legit |
| F-08 | High | High | Registration sweeps terminal deferred/clock state and writes or arms historical work | Source | Legit |
| F-09 | High | High | Durable rows, journal/archive history, branch ledgers, and CAS blobs still lack automatic retention policy | Source + documented gap | Legit; remaining production retention gap |
| F-10 | Medium | Medium | Sixty-four live-but-stale owners can starve the stale-run sweep and spam the journal | Source | Legit |
| F-11 | Medium | Low | Suspended-flow retry bounds reset on each caller/process restart | Source; explicitly designed this way | Partial: intentional semantics with contradictory naming/docs |
| F-12 | High | High | Fork database creation and workspace creation are non-atomic; workspace names also collide | Source | Legit |
| F-13 | High | High | A forked workspace starts at the lane default, not the requested historical frame | Source + documented warning | Legit; disclosed missing feature |
| F-14 | High | Medium | Branch-command exactly-once admission fails across two server instances | Reproduced + source-forced | Partial: mechanism is real; supported multi-instance topology is unstated |
| F-15 | Medium | Low | A roster watch never observes the last participant's lease expiry | Source | Legit |
| F-16 | Medium | Medium | Live sync reconnects immediately forever with no delay or retry budget | Source | Legit |
| F-17 | Medium | Medium | Workspace sync fans out with unbounded concurrency and unbounded notification queues | Source | Legit; hardening gap |
| F-18 | Low | Low | `requestCancel` mutates already-terminal runs and calls it a new request | Source | Legit |
| F-19 | Low | Low | Current time-travel documentation contradicts the frame-derived fork implementation | Source/docs | Legit |
| R-01 | — | Medium | Live sync performs a fresh RPC and workspace-wide stream fan-out for every journal frame | Source | Raised by Fable; confirmed |
| R-02 | — | Low | `WatchRoster` has no atomic subscribe-before-snapshot boundary | Source | Raised by Fable; confirmed |
| R-03 | — | Low | One undecodable historical deferred row can permanently kill flow registration | Source | Raised by Fable; confirmed resilience defect |

## Detailed defect findings

### F-01 — ordinary cancellation acknowledges a failed durable write

`RunDriver.interrupt` sets the local live-instance flag, calls
`RunStore.requestCancel`, suppresses every error with `Effect.ignore`, then
interrupts the coordinator (`packages/engine-store/src/internal/RunDriver.ts`,
lines 1237–1251). If the database write fails, interruption settlement cannot
find durable cancellation evidence and deliberately releases the run back to
`suspended`, making it eligible to execute again. The public contract says
`interrupt` “requests cancellation ... preserving normal cleanup,
compensation, and child-flow handling,” but the caller receives success.

This is not hypothetical behavior hidden from tests:
`packages/engine-store/test/RunDriverEdges.test.ts` lines 419–468 injects a
failed `requestCancel` and pins the resulting released—not cancelled—row. The
safety choice inside settlement is correct (no durable evidence must not be
invented); the API acknowledgement is the defect. At minimum, only `NotFound`
should be absorbed. A persistence failure must reach the caller or remain in a
durable pending-control state.

Smithers analogues: [#1496](https://github.com/smithersai/smithers/issues/1496)
and the dead-owner cancel-pending fixes
[`8cac542`](https://github.com/smithersai/smithers/commit/8cac5420de4fd1af92ade250b360e8c830ffff07)
and
[`66166ce`](https://github.com/smithersai/smithers/commit/66166ceb9567336ec3fb30b13029d0a3819999d0).

### F-02 — cancellation observed by another process skips linked children

The running driver races the body against `cancelPollLoop`. When the polling
branch wins, it calls `cancelOwned`, but it never sets the live
`FlowInstance.interrupted` flag (`RunDriver.ts` lines 819–839). The linked-child
finalizer in `packages/engine/src/FlowEngine/make.ts` lines 100–109 cancels the
child only when that exact flag is true. The only code that sets it is the
same-process `driver.interrupt()` path.

Result: a cancellation written through `RunStore.requestCancel` by a control
process can terminalize the parent while its active child remains running.
This was reproduced with a temporary focused Vitest: after an external cancel,
the row was `cancelled` but the finalizer observed
`instance.interrupted === false`. The temporary audit test was removed after
the run.

Smithers analogues:
[#971](https://github.com/smithersai/smithers/issues/971),
[#972](https://github.com/smithersai/smithers/issues/972), and the agent-tree
containment fixes
[`baec700`](https://github.com/smithersai/smithers/commit/baec700f1df1af4ecac28330e8ee574f838b2cfb)
and
[`d2d7f12`](https://github.com/smithersai/smithers/commit/d2d7f12e61f424c7dc959c2dd72f0d9b8633c39b).

### F-03 — parked cancellation abandons the flow scope

Every durable drive creates a new instance and an unsafe closeable scope
(`RunDriver.ts` lines 812–816 and
`packages/engine/src/FlowEngine/FlowInstance.ts` lines 26–57). A suspension is
the sole result for which `Flow.intoResult` deliberately does not close that
scope (`packages/flow/src/Flow/Runtime.ts` lines 78–91). The driver then removes
the instance from `liveInstances` and retains no durable or in-memory reference
to it.

When a cancel is later delivered to the parked row, the activation cancel guard
calls `cancelOwned` before creating a new instance (`RunDriver.ts` lines
790–803). Nothing can close the old scope. `Flow.addFinalizer`,
`Flow.provideScope`, and `Flow.withRollback` explicitly attach to that scope, so
cleanup and rollback promised by the ordinary cancellation API never run.

This was reproduced with a temporary focused Vitest: a finalizer registered on
the instance scope, followed by suspension and external parked cancellation,
ran zero times even though the run became `cancelled`. The temporary test was
removed after the run.

This is broader than a one-row leak: every suspension discards an open scope.
Replay may reconstruct some logical finalizers on a later drive, but it cannot
close resources or callbacks held by the discarded instance, and a terminal
parked cancel has no later replay on which to reconstruct them.

Smithers analogues: [#1496](https://github.com/smithersai/smithers/issues/1496),
[#972](https://github.com/smithersai/smithers/issues/972), and
[`0a30b14`](https://github.com/smithersai/smithers/commit/0a30b14a6aadbc3dc39402df06ed054d6ec70d2b).

### F-04 — no transactional recursive cancellation primitive

Flows persists parentage in `flows_run_parents` and `parent_run_id`, but
`RunStore.requestCancel(runId, nowMs)` updates one row only. No public store or
engine operation walks and marks a subtree in one transaction. The runtime
tries to link a child through an in-memory finalizer; F-02 and F-03 show why
that cannot provide crash-safe or cross-process lifecycle ownership.

The child-spawn journal boundary is also hard-coded as `attached: false`
(`RunDriver.ts` lines 1127–1156), while engine authoring still promises linked
child interruption. The time-travel meaning of “detached” need not be identical
to cancellation ownership, but there must be one durable relation that says
which descendants a cancellation owns and an atomic operation that marks all
of them.

Smithers analogues:
[#971](https://github.com/smithersai/smithers/issues/971),
[#972](https://github.com/smithersai/smithers/issues/972), and
[#885](https://github.com/smithersai/smithers/issues/885).

### F-05 — cancellation depends on handler registration

`RunDriver.drive` decodes `flowName` and returns before claiming or checking the
cancel activation guard when the flow is unregistered (`RunDriver.ts` lines
758–787). That is correct for executing a body, but terminal cancellation does
not need a handler: `cancelOwned` needs only the generic persisted `RunState`
and an ownership fence.

Consequently, a generic control process can record cancellation but cannot
finish a parked/dead run. It must wait for some process that registers the flow
implementation. This is the same operator-visible “cancel pending until a
second capable owner arrives” class as Smithers
[#1496](https://github.com/smithersai/smithers/issues/1496). The current
unregistered-flow warning test verifies that the row stays parked; it does not
separate executable resume from control-only settlement.

### F-06 — cancellation has no attribution

`flows_runs` stores only `cancel_requested_at_ms`; `RunStore.requestCancel`
accepts only `(runId, nowMs)`. The `flows.engine.interrupted` record carries the
settling owner and timestamp, not the source actor, transport, signal, request
ID, or reason. The local gap document already admits the missing RunControl
attribution even while calling cancellation closed.

This directly matches Smithers
[#980](https://github.com/smithersai/smithers/issues/980). Attribution must be
part of the durable request, not inferred from whichever owner eventually
settles it.

### F-07 — durable `interruptUnsafe` does not implement its contract

The port documents ordinary `interrupt` as cleanup-preserving and
`interruptUnsafe` as immediate cancellation that may skip compensation and
orphan children (`packages/engine/src/FlowEngine/Encoded.ts` lines 76–90 and
`packages/flow/src/FlowRuntime/FlowRuntime.ts` lines 118–136). The memory engine
implements two paths. The durable RunDriver returns
`interruptUnsafe: Effect.fn(...)(interrupt)`—the exact same function
(`RunDriver.ts` lines 1295–1299).

Even if a durable force-cancel needs a new state-machine design, exposing the
method as though it exists is a contract violation. It also makes it impossible
for an operator to escape a stuck cleanup path, one of the practical reasons
Smithers distinguishes containment/reaping operations.

### F-08 — registration sweeps terminal deferred and clock state

Registering a flow always invokes `deferred.sweepDue(flow._tag)`
(`packages/engine-store/src/EngineStore.ts` lines 227–231). That sweep selects
every completion ever recorded for the flow, with no join to run status and no
pending/waiting predicate
(`packages/engine-store/src/DurableEngineState.ts` lines 941–960). Completion
rows are permanent.

For each row, `scheduleResume` reads and decodes the run, emits a durable
`wake-scheduled` decision, then asks the coordinator to wake it
(`RunDriver.ts` lines 1254–1275). There is no terminal-status guard before the
journal write. A terminal run is rejected only later by `claimAndActivate`.

Every process start/registration is therefore O(all historical completions for
that flow), and every pass appends more wake events even for completed,
failed, or cancelled runs. Several deferred completions for one execution
produce duplicate wakes. This is a direct amplification path for the retention
failures in Smithers
[#1349](https://github.com/smithersai/smithers/issues/1349) and
[#1491](https://github.com/smithersai/smithers/issues/1491).

The clock half of the same registration sweep has the same missing run-status
join. `pendingClocks` selects every incomplete clock for the flow, including a
future clock belonging to a run that has since failed or been cancelled.
Registration re-announces and arms each one in every process; when it becomes
due it completes a deferred and schedules a wake even though the run is
terminal (`DeferredPersistence.ts` lines 211–248 and 312–333;
`DurableEngineState.ts` lines 895–936). There is no terminalization path that
marks those clock rows complete. Stable producer identity may deduplicate some
re-announcements within one configured source, but it does not remove the
timer fan-out or the terminal deferred work.

### F-09 — retention gaps across durable stores

At the audit baseline there was no run deletion API, no journal
compaction/checkpointing, no attempt retention job, no deferred/clock cleanup,
no time-travel archive retention, and no published-blob GC. Journal
checkpointing/compaction and explicit artifact GC have since shipped. The
remaining retention gaps are the lack of run deletion, attempt retention,
deferred/clock cleanup, and time-travel archive retention; compaction and GC
remain explicit operations rather than automatic retention jobs. The artifact
service now exposes `ArtifactSweep`, and `ArtifactGc` in engine-store computes
the durable live set before sweeping. Step-cache eviction remains per key. The
`flows_run_parents_gc` trigger cleans graph edges if a lane deletes a run; it
does not provide that lane.

Long-lived installations can still grow without bound without operator-invoked
compaction, GC, and retention jobs:

- `flows_runs`, `flows_attempts`, and `flows_journal_events`;
- deferred completions, clock deadlines, wait metadata, and repeated wake
  decisions from F-08;
- time-travel audits, receipts, snapshots, archive rows, and detached lineage;
- branch command history and its rehydrated in-memory ledger;
- published CAS blobs and local/shared cache records.

This remains a production blocker for a complete retention contract. Smithers
[#1349](https://github.com/smithersai/smithers/issues/1349) records the
eventual outcome—100GB control databases—and
[#1491](https://github.com/smithersai/smithers/issues/1491) records the same
class for logs/worktrees.

### F-10 — stale-run sweep starvation and write amplification

The stale-running sweep selects the 64 oldest stale heartbeats every second
(`RunDriver.ts` lines 1002–1015;
`DurableEngineState.ts` lines 1103–1120). If `isAlive(owner)` says those
processes are alive—PID alive but engine wedged, a conservative cross-host
probe, or a permanently stale lease—the claim path refuses each steal and
journals `steal-refused-owner-alive` (`RunDriver.ts` lines 276–290).

Those rows remain the oldest and monopolize every next batch. A dead row at
position 65 is never examined, while the first 64 add one durable refusal each
tick. The cap solves mass-death contention only when each selected row leaves
the stale set; it needs a cursor, refusal backoff/next-check timestamp, or a
query that excludes recently probed rows.

Smithers analogues: stale-heartbeat/orphan work in
[`1b9e0e0`](https://github.com/smithersai/smithers/commit/1b9e0e0d4947fa64276511b443bd5f0ad6ba6b7b)
and [#1496](https://github.com/smithersai/smithers/issues/1496).

### F-11 — suspended retry bounds are per invocation, not durable

`FlowEngine.makeUnsafe.execute` initializes `resumeAttempt = 0` and
`resumeStartMs = now` for each caller (`packages/engine/src/FlowEngine/make.ts`
lines 138–149). The source explicitly says a restart receives a fresh budget,
although the nearby comment later says the backoff survives restart. Thus
`maxAttempts` and `expirationMs` on `suspendedRetryPolicy` can be bypassed by
restarting the caller/process repeatedly.

Action retry state is correctly persisted through attempt rows, which makes
the contrast important. If `suspendedRetryPolicy` is only a per-call polling
budget, its name and documentation need to say so and it should not be used as
a run-level bound. If it is meant to bound a durable wait, attempt and origin
belong in persisted run state. Smithers' relevant repairs are
[`b83378b`](https://github.com/smithersai/smithers/commit/b83378b7040409fcc81c7e6b42ab6600bd48480e)
and
[`0ece235`](https://github.com/smithersai/smithers/commit/0ece235eb6e9f67ced020e36404258143c259c93).

### F-12 — fork creation is non-atomic and workspace identity collides

`Fork.fork` commits `TimeTravelStore.createFork` first and calls
`jj.workspaceAdd` second
(`packages/time-travel/src/internal/Fork.ts` lines 128–140). A failed workspace
add leaves a pending child run, copied attempts/journal, and lineage edge even
though the public fork operation failed. There is no compensating DB delete or
recoverable audit state.

The public service derives workspace name/path solely from
`(parentRunId, frame.seq)` (`packages/time-travel/src/TimeTravel.ts` lines
153–157 and 248–258), while SQL intentionally numbers repeated forks as
`...:fork:<seq>:1`, `:2`, and so on
(`SqlTimeTravelStore.ts` lines 533–537). Therefore two valid forks from the
same frame request the same jj workspace. The first stays registered for the
service scope; the second commits its distinct child and then fails on the
duplicate workspace. Sanitizing all non `[A-Za-z0-9._-]` characters to `-`
also makes distinct run IDs collide.

The database mutation and workspace provision need a recoverable protocol:
derive the lane from the returned child run ID, record phases, and either roll
back an unprovisioned child or resume provisioning after failure.

Smithers lessons: transactional finalization in
[`e0624e0`](https://github.com/smithersai/smithers/commit/e0624e01e5d69d2a0c8cdd3c32b6fa1fc95d9e43)
and checkpoint/workspace hardening in
[`d791834`](https://github.com/smithersai/smithers/commit/d79183496a884e42ba37564e810071c6b5d89ed5).

### F-13 — a fork's filesystem is not at its requested frame

The store now correctly derives executable state and attempts at the requested
journal frame. The jj workspace does not: `workspaceAdd` has no revision
parameter, so the fork starts at the lane default and returns only a warning
(`Fork.ts` lines 142–169). A child can therefore combine historical DB state
with current filesystem state and execute under a false time-travel premise.

This is disclosed and ticketed, so it is not a hidden implementation bug; it
is nevertheless a correctness blocker for fork execution involving files.
Smithers' relevant fixes are the pre-attempt restore and checkpoint provenance
work:
[`e364005`](https://github.com/smithersai/smithers/commit/e364005eb1c28b8e2c7cc08fbe3b9f384e54a783)
and
[`71c0c94`](https://github.com/smithersai/smithers/commit/71c0c94f3fb2221ae82d46b78bbe8109ab4e781c).

### F-14 — branch command exactly-once is process-local

`BranchCommands.makeLive` owns an in-memory semaphore, ledger map, and hydrated
set (`packages/sync/src/BranchCommands.ts` lines 115–121). Admission checks that
map and then writes an ordinary journal event; `commandId` is JSON payload, not
a durable unique key or compare-and-set (`BranchCommands.ts` lines 162–207).

Two server instances can both hydrate an empty prefix and append the same
command ID. A temporary focused Vitest forced both hydrations to complete
before either write: the contract expected one durable write and observed two.
The temporary test was removed. The projection later ignores the duplicate,
but the journal contains two admitted commands and the two callers receive
different canonical sequence numbers; any command side-effect consumer can
still execute twice.

This is a split-brain idempotency defect. Admission must use a durable command
identity table/constraint in the same transaction as the journal append, or
the journal must accept a caller-supplied stable producer identity derived from
`commandId`. Smithers' general analogue is force/resume split-brain protection
in [#1056](https://github.com/smithersai/smithers/issues/1056).

### F-15 — roster lease expiry is not observable by an existing watcher

Expired participants are deleted only when `BranchPresence.list` calls `live`
(`packages/sync/src/BranchPresence.ts` lines 171–181 and 209–213). The roster
watch emits one initial list and then re-lists only on `announce` or `leave`
events (`packages/sync/src/BranchServer.ts` lines 81–90).

If the last participant disappears without `leave`, no survivor heartbeat
publishes another event. An already-open watcher continues showing that
participant forever, even though a new one-shot `Roster` call would return an
empty list. Lease expiry needs a timer/next-expiry wake or a presence stream
that emits expiry changes itself.

There is a second edge in the same implementation: `live(branchId, nowMs)`
deletes expired entries for every branch while returning only the requested
branch, and it publishes no expiry event for any of them. Listing branch A can
therefore silently remove branch B's expired entries while B's watchers remain
stale. This does not raise the final severity because presence is advisory and
the next announce self-heals it, but it reinforces that expiry is not an
observable state transition.

### F-16 — live sync has an unbounded immediate reconnect loop

After bootstrap, a `transport_failed` subscription calls `live()` immediately;
`live()` concatenates another one-credit subscription forever
(`packages/sync/src/SyncClient.ts` lines 153–185). There is no yield delay,
backoff, jitter, retry cap, cancellation classification, or logging. An
immediately failing transport can hot-loop RPC construction and CPU/network
usage. Initial bootstrap failure, in contrast, is terminal, so the two phases
also have inconsistent recovery policy.

This matches the resource-exhaustion shape behind Smithers
[#1332](https://github.com/smithersai/smithers/issues/1332) and the broader
self-healing policy gap in
[#1500](https://github.com/smithersai/smithers/issues/1500).

### F-17 — sync fan-out and notification buffering are unbounded

A workspace subscription opens one journal stream per run with
`concurrency: "unbounded"`, and does the same for newly registered runs
(`packages/sync/src/SyncServer.ts` lines 208–225). `RunCatalog` and
`BranchPresence` use unbounded PubSubs. Credit limits emitted frames, not the
number of open streams or queued notifications.

A workspace with many runs, or a slow roster/run subscriber receiving a high
event rate, can therefore allocate an unbounded number of fibers/queues before
credit terminates the stream. Existing soak tests cover release after bounded
subscriptions, not admission limits for a large workspace or a permanently
slow subscriber. A configurable concurrency and bounded/coalescing change
channel are needed before treating this as an Internet-facing service.

### F-18 — terminal rows accept new cancellation intent

`RunStore.requestCancel` updates any existing row whose cancel timestamp is
null; it does not filter `status` (`packages/run-store/src/RunStore.ts` lines
666–710). Cancelling a completed or failed execution returns
`CancelRequested`, mutates its control metadata, and makes later callers see
`AlreadyRequested`, while its actual status/result remains terminal.

The practical impact is mostly observability and API truthfulness, but terminal
state should be an explicit outcome, not a successful new control request.
Smithers fixed the analogous terminal enqueue race in
[`1ad95a0`](https://github.com/smithersai/smithers/commit/1ad95a01993beb69e109dec5235a75e8e9915bc4).

### F-19 — time-travel status documentation is stale

`docs/architecture/implementation-status.md`,
`docs/concepts/time-travel.md`, `docs/pages/external.md`, and
`docs/pages/design-decisions.md` still say SQL forks copy the parent's current
state and all attempts. Current `SqlTimeTravelStore.createFork` does the right
thing: it folds state at the frame and copies only attempts evidenced by that
prefix (`SqlTimeTravelStore.ts` lines 539–596), with tests that pin both.
`docs/reference/time-travel.md` already documents the corrected behavior, so
the documentation also contradicts itself. The implementation keeps current
state only as a compatibility fallback when an old journal has no
frame-derived state. This is a documentation defect, not a runtime defect, but
it misstates a central correctness property and can drive the wrong migration
decision.

## Findings added by the independent review

### R-01 — one live entry causes one full resubscription

`SyncClient` hard-codes `credit: 1` for every live `Sync.Subscribe` call
(`packages/sync/src/SyncClient.ts` lines 153–164). The server emits one frame
per journal entry and applies `Stream.take(request.credit)` after constructing
the run streams (`packages/sync/src/SyncServer.ts` lines 181–225). After that
single frame, the client recursively creates another RPC subscription.

For a run-scoped client this is one RPC setup per event. For a workspace-scoped
client it is also a new `runIdsFor` pass and an O(number of visible runs) stream
fan-out per event. Cursoring preserves correctness, but the protocol turns
ordinary throughput into repeated subscription setup and multiplies F-16 and
F-17. Credit should be a real window that can be replenished, or at minimum a
configurable multi-frame batch.

### R-02 — roster snapshot and change subscription are not atomic

`Branch.WatchRoster` merges `Stream.fromEffect(presence.list(payload))` with a
separately acquired PubSub-backed change stream
(`packages/sync/src/BranchServer.ts` lines 81–90). `Stream.merge` starts both
concurrently, but it cannot make the snapshot read and PubSub subscription one
atomic operation. An announce or leave after the snapshot is read but before
the PubSub subscriber is installed is absent from both sides, leaving the
watcher stale until a later change.

The standard protocol is subscribe first, then take the snapshot while that
subscription is already buffering changes, and finally drain/coalesce changes
after the snapshot. This is Low because roster state is advisory and later
heartbeats repair it; it is separate from F-15's deterministic zero-survivor
expiry hole.

### R-03 — corrupt deferred history can poison registration

`DurableEngineState.completedDeferreds` decodes every historical row with
`Effect.orDie` (`packages/engine-store/src/DurableEngineState.ts` lines
941–960). `EngineStore.register` runs the resulting sweep as a `tap` on handler
registration (`packages/engine-store/src/EngineStore.ts` lines 227–231). One
malformed historical row for a flow therefore defects every attempt to
register that flow, including rows belonging to long-terminal executions.

Normal writers validate the row, so this requires corruption, manual repair,
or an incompatible historical representation and is Low severity. It is still
a poor failure boundary: quarantine/report the bad row and continue registering
the handler, or expose a typed storage-integrity failure rather than turning
unrelated flow availability into an unrecoverable defect.

## Documented production/parity gaps

These are legitimate findings but should not be confused with regressions.
They already appear, sometimes inconsistently, in the local architecture docs.

| ID | Gap | Smithers applicability |
| --- | --- | --- |
| G-01 | No attributed `RunControl`, user-facing pause, or hijack service | Smithers has mature control paths; #980 supplies the attribution lesson |
| G-02 | No durable process-tree registry/reaper | Relevant to agent/child-process integrations; Smithers #972/#1332 and containment commits are direct prior art |
| G-03 | No checkpoint host capability or durable worktree-lane lifecycle | Smithers checkpoint publication, retry, provenance, restore, and worktree cleanup code is directly applicable |
| G-04 | No quota-error classifier and wake policy | Smithers provider classification belongs behind an injected seam, not hard-coded in core |
| G-05 | No packaged production layer at the audit baseline; `@smthrs/flows/NodeRuntime` has since shipped the storage-and-engine half | Half the cutover artifact exists; host services, the guarded kernel, `StepBoundary`, and `WorkspaceSandbox` are still the embedder's. `packages/flows/test/NodeRuntime.test.ts` directly gates that module over real SQLite. |
| G-06 | SQLite-only shipped storage/migration layers | Smithers' PGlite/Postgres installations cannot adopt the store as written |
| G-07 | Event-driven resume signal is absent | Polling is correct fallback but adds latency/load and complicates bounded retry semantics |
| G-08 | Artifact GC is shipped as explicit mark/sweep; chunked transfer and download policy remain absent | Smithers #1349/#1491 make retention and worktree cleanup operational requirements |
| G-09 | No default journal retention job; checkpointing/compaction are shipped as explicit or opt-in operations | Directly exposed by F-08/F-09 |
| G-10 | Diff-review gate and parts of the sandbox filesystem surface are absent | Required for Smithers agent/worktree parity, not for the minimal executor |
| G-11 | Flow registrations are in memory | A restarted worker must re-register before execution; F-05 shows control-only settlement should be separated |
| G-12 | Plan admission caps do not account for lifecycle-linked child runs | Smithers #885 is relevant if child flows are meant to consume agent capacity |
| G-13 | Self-healing has retry but no general repair/replacement primitive | Smithers #1500 is architectural prior art rather than a drop-in patch |

## Smithers items reviewed and found not directly transferable

- [#1492](https://github.com/smithersai/smithers/issues/1492), the
  `Infinity` loop-cap bug, does not apply. Flows accepts only a positive safe
  integer `maxRounds`; omission is its unbounded sentinel.
- [#584](https://github.com/smithersai/smithers/issues/584), failure to expand
  `resetNodes` to downstream dependants, has no corresponding API in Flows.
  Rewind archives a journal suffix; fork derives a prefix.
- [#1450](https://github.com/smithersai/smithers/issues/1450), resume requiring
  the caller to resupply inputs, is already avoided: Flows persists payload in
  `RunState` and `resume` takes only flow identity plus execution ID.
- [#1431](https://github.com/smithersai/smithers/issues/1431), an approval
  decided while another gate wins, cannot be transferred yet because Flows has
  waiting metadata but no approval resolver/control service. It becomes a
  required test when G-01 lands.
- [#1153](https://github.com/smithersai/smithers/issues/1153), transcript
  attempt scoping, has no transcript subsystem here. Its general retention
  lesson is covered by F-09.
- [#1056](https://github.com/smithersai/smithers/issues/1056), force-resume
  against a live driver, is mostly avoided by ownership CAS and the keyed run
  coordinator. Its split-brain lesson does apply to F-14.
- [#1326](https://github.com/smithersai/smithers/issues/1326), local PID
  liveness in a multi-host deployment, is explicitly avoided by the
  `LivenessProbe` contract. The quality of the application-supplied cross-host
  probe remains a deployment responsibility and influences F-10.

## Reusable Smithers implementation lessons

The most useful code is not a file to copy wholesale; it is a set of protocol
boundaries already debugged under failure:

1. **Control state and terminalization in one durable transaction.** The steer
   fixes
   [`e0624e0`](https://github.com/smithersai/smithers/commit/e0624e01e5d69d2a0c8cdd3c32b6fa1fc95d9e43),
   [`0d96f88`](https://github.com/smithersai/smithers/commit/0d96f8865c0a7fc4fbe5ced8f7cdb6f1143f87c3),
   and
   [`1ad95a0`](https://github.com/smithersai/smithers/commit/1ad95a01993beb69e109dec5235a75e8e9915bc4)
   show the correct seam for cancellation attribution, terminal fencing, and
   pending-control cleanup.
2. **Durable subtree/process containment.** The cancel-cascade, agent registry,
   parent-death watchdog, process-group tests, and orphan reaper added by
   [`baec700`](https://github.com/smithersai/smithers/commit/baec700f1df1af4ecac28330e8ee574f838b2cfb),
   [`d2d7f12`](https://github.com/smithersai/smithers/commit/d2d7f12e61f424c7dc959c2dd72f0d9b8633c39b),
   and
   [`1b9e0e0`](https://github.com/smithersai/smithers/commit/1b9e0e0d4947fa64276511b443bd5f0ad6ba6b7b)
   are the model for F-02/F-04/G-02.
3. **Persist retry/checkpoint phase, not just the final result.** The cluster
   around
   [`d791834`](https://github.com/smithersai/smithers/commit/d79183496a884e42ba37564e810071c6b5d89ed5),
   [`0ece235`](https://github.com/smithersai/smithers/commit/0ece235eb6e9f67ced020e36404258143c259c93),
   [`b83378b`](https://github.com/smithersai/smithers/commit/b83378b7040409fcc81c7e6b42ab6600bd48480e),
   [`e364005`](https://github.com/smithersai/smithers/commit/e364005eb1c28b8e2c7cc08fbe3b9f384e54a783),
   and
   [`71c0c94`](https://github.com/smithersai/smithers/commit/71c0c94f3fb2221ae82d46b78bbe8109ab4e781c)
   applies to F-11/F-12/F-13.
4. **Bound every historical/indexed dimension.** Smithers #1349/#1491 and the
   later source-event cache fixes reinforce that a durable store needs a
   retention API at the same time it gains append-only evidence.
5. **Normalize asynchronous return shapes at boundaries.** Smithers
   [`d916161`](https://github.com/smithersai/smithers/commit/d916161e82a93efcf0cdb95e1b4682d2ea51b8c7)
   and
   [`b2ae875`](https://github.com/smithersai/smithers/commit/b2ae875ea521181453e4e642dca4329be4268965)
   did not expose an equivalent current Flows defect, but their tests are worth
   retaining when new adapters accept `Effect | Promise` or thenables.

## Verification performed

- Focused external-running-cancel test: failed its assertion because
  `instance.interrupted` remained false while the row became cancelled.
- Focused parked-cancel-scope test: failed its assertion because the registered
  scope finalizer ran zero times after terminal cancellation.
- Focused two-instance branch-command test: failed its exactly-once assertion,
  observing two durable writes for one command ID.
- TypeScript checks passed for `@smthrs/engine-store`,
  `@smthrs/engine`, `@smthrs/run-store`,
  `@smthrs/time-travel`, `@smthrs/journal`, and
  `@smthrs/sync` at the audit baseline.
- No full repository test run was performed, per repository instructions.
- All temporary audit tests were removed. Only this report was added; unrelated
  worktree edits were not modified.

## Independent Claude Fable review

The required review was run with Claude CLI 2.1.231 and the Fable alias. The
initial all-at-once, tool-assisted invocation did not return a usable answer,
so it was stopped without edits. The successful review used three bounded
evidence packets under the same requested command:

```sh
claude -p --model fable --permission-mode dontAsk --tools '' \
  --no-session-persistence --output-format text
```

Each packet contained the candidate prose plus the exact current source,
test, and documentation regions needed to challenge it. Disabling Claude's
tools made the review read-only by construction and avoided the traversal loop
from the first attempt. The reviewer was explicitly told to distrust deleted
reproduction tests, give a strongest counterargument, distinguish bugs from
intentional semantics/docs/gaps, and choose `LEGIT`, `PARTIAL`, or
`NOT_LEGIT` for every `F-*` row.

### Per-finding verdicts

| ID | Verdict | Severity | Classification and decisive review point |
| --- | --- | --- | --- |
| F-01 | Legit | Medium | Bug: broad `Effect.ignore` falsely acknowledges persistence failure; release without durable evidence remains intentional |
| F-02 | Legit | High | Bug: the poll winner closes the scope before any code sets `instance.interrupted`, so the linked-child finalizer cannot act |
| F-03 | Legit | High | Contract bug over an intentional replay trade-off: a terminal parked cancel has no later replay that could reconstruct compensation |
| F-04 | Partial | Medium | Missing feature/remedy: the single-row primitive is valid, but some durable owner still must implement the promised child lifecycle |
| F-05 | Legit | Medium | Liveness bug: registration gating precedes generic cancel settlement and adds no compensation benefit under F-03 |
| F-06 | Legit | Low | Known missing feature affecting forensics rather than execution correctness |
| F-07 | Legit | Medium | Contract bug/missing feature: durable `interruptUnsafe` is literally the safe path alias while memory mode has two behaviors |
| F-08 | Legit | High | Bug: all-time completion selection, terminal wake journaling, and no dedup make every registration cost grow with history |
| F-09 | Legit | High | Remaining retention gap; journal compaction and artifact GC are explicit, but run, attempt, deferred/clock, and archive cleanup are still missing |
| F-10 | Legit | Medium | Bug: refused rows never change ordering or next-probe time, so starvation and repeated durable refusal writes follow |
| F-11 | Partial | Low | Intentional per-caller semantics; the misleading policy name and contradictory restart comments are the surviving defect |
| F-12 | Legit | High | Bug: same-frame re-fork deterministically combines a duplicate workspace with an already-committed child |
| F-13 | Legit | High | Disclosed missing feature but still a correctness blocker: frame state and lane-default files can be executed together |
| F-14 | Partial | Medium | Durable idempotency is absent, but the severity depends on multi-instance branch service deployment, which is not documented as supported |
| F-15 | Legit | Low | Bug: the no-timer design's own survivor-heartbeat argument fails when the survivor count reaches zero |
| F-16 | Legit | Medium | Bug: transport failure is hidden inside immediate recursive resubscription, leaving consumers unable to impose backoff |
| F-17 | Legit | Medium | Internet-facing hardening gap: credit bounds output frames only after unbounded streams and queues are allocated |
| F-18 | Legit | Low | API-truthfulness bug: monotonic intent may be defensible, but `CancelRequested` is false for an immutable terminal result |
| F-19 | Legit | Low | Documentation defect, with four stale locations and a legacy-state fallback nuance |

The review's cross-cutting conclusion was that F-02, F-03, and F-05 are three
faces of one design choice: durable cancellation settles by store transition
without being delivered into a live or replayed flow body. Setting a flag or
moving a guard fixes individual symptoms, but compensation semantics need one
explicit decision—replay cancellation into the flow, or narrow the public
contract.

### Reviewer additions and rejected additions

Fable raised the issues now recorded as R-01 through R-03. It also sharpened
F-08 with terminal clock re-arming, F-15 with silent cross-branch expiry, and
F-19 with two additional stale published pages; those were folded into the
original rows.

The following reviewer suggestions were not elevated:

- Time-travel's successful-workspace `workspaceForget` finalizer is explicitly
  documented as service-scope ownership in `docs/pages/api/time-travel.md`; it
  is not an accidental lifetime bug. Its path/collision implications remain
  covered by F-12.
- `SyncClient` carrying acknowledged cursors into later subscriptions is an
  intentional local-replica behavior pinned by `ClientCursors.test.ts`, not
  cross-subscription cursor bleed.
- The in-memory branch-command ledger is unbounded, but that is already counted
  in F-09/F-17 rather than duplicated.
- Possible recursive-stream continuation accumulation under F-16 was not
  elevated because the packet did not prove Effect's internal allocation
  behavior; the immediate retry loop itself is sufficient and proven.
