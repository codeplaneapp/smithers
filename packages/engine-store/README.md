# @smthrs/engine-store

Durable persistence adapter for `@smthrs/engine`. It composes journal-backed
run ownership, attempts, cache provenance, deferreds, clocks, and workspace
snapshot boundaries into a `FlowEngine` layer.

```sh
pnpm add @smthrs/engine-store
```

## Bundles for the browser, runs on SQLite

**This entry point bundles for a browser.** The two host reads it once made
directly — `process.pid` and `randomUUID` from `node:crypto`, used to identify
an owner and stamp attempt nonces — now enter through the injectable
`OwnerIdentity` service, whose default reads a process id off `globalThis`
where one exists and draws an incarnation number from `Random` where none
does (issue #114). The SQL it drives is driver-neutral — `@smthrs/journal`
and `@smthrs/database` both bundle too — but the only `DurableWriter` backing
shipped here is `node:sqlite` through `@effect/sql-sqlite-node`, so a browser
deployment must supply its own SQL client.

`scripts/browser-check.mjs` at the repository root pins that boundary: it
bundles this entry point for the browser and fails the build if it regresses.
See [browser support](../../docs/architecture/browser-support.md).

## Public API

The root exports these namespaces; each is also available from its matching
`@smthrs/engine-store/*` subpath.

| Namespace            | Public exports                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DurableEngineState` | `DurableEngineState` / `Service` persist deferreds, clocks, and parked-run state through `deferred`, `completeDeferred`, `clock`, `scheduleClock`, `completeClock`, `dueClocks`, `completedDeferreds`, `park`, `wake`, `waiting`, and `waitingRuns`. Address/row types are `DeferredAddress`, `DeferredRow`, `ClockAddress`, `ClockRow`, `Waiting`, `WaitingRow`, and `WaitingRunsFilter`; outcome types are `CompleteDeferredOutcome`, `ScheduleClockOutcome`, `CompleteClockOutcome`, `ParkOutcome`, and `WakeOutcome`; `WaitingReason` is the open wait taxonomy. `make` / `layer` use `DurableWriter`; `makeMemory` / `layerMemory` are deterministic in-memory variants. |
| `EngineStore`        | `Options` configures owner identity, journal source, liveness probing, and the optional `clockFireRetryPolicy` (defaults to exponential from 100ms capped at 30s, forever). `make` builds the service and `layer` provides `FlowEngine` plus `SnapshotBoundary`; `EngineCompositionError` is the stable composition error.                                                                                                                                                                                                                                                                                                                                                    |
| `StepBoundary`       | `PreparedBoundary`, `BoundaryDeviation`, `BoundaryEvidence`, `Service`, and `StepBoundary`; errors `UndeclaredWrite`, `UnsupportedBoundary`, and `BoundaryCorruption`; production and test layers. The shared declaration types `FileBoundary`, `BoundaryMode`, and `FileInput` live in `@smthrs/flow`'s `Action` namespace.                                                                                                                                                                                                                                                                                                                                                  |
| `WorkspaceSandbox`   | The functional workspace transaction. Models `Resource`, `InputObservation`, `OutputObservation`, `Provenance`, `FileChange`, `QueuedEffect`, `WorkflowResult`, `Execution`, `DeclarationViolation`, `CacheDisposition`, `Accepted` / `Invalidated` / `ExecutionResult`, and `Host`; services `Workspace` (the in-transaction filesystem and effect outbox) and `EffectDispatcher`; errors `WorkspaceError` and `MaterializationConflict`; the `violations` accessor; `make` / `layer`, `makeHosted`, `makeMemory` (deterministic, browser-safe), and `makeFileSystem` / `layerFileSystem` / `layerDispatcher`.                                                               |
| `PlanScheduler`      | Drives a persisted `@smthrs/plan` `Plan`. `Options` configures the run, the admission caps (`concurrency.steps` / `concurrency.agents`, both defaulting to unbounded and both flooring at one), and the `rebaseLimit`; `make` / `layer` build the `Service` (`record`, `append`, `run`) and `PlanScheduler` is its tag. `NodeExecutor` / `Executor` / `layerExecutor` are the DI seam that turns a `NodeInput` into work, `Outcome` is the four-way evaluation result, `Settlement` and `Report` are what a run reports, `Requirements` is what driving one needs, and `SchedulerError` is the scheduler's own refusal.                                                       |
| `Reconciliation`     | The pluggable seam that answers a `Deviation` or a `Conflict` with a `Verdict` (`Fail` / `Reorder` / `FactorOut`). `Reconciliation` / `Service` are the tag and shape; `make` / `layer` install one; `makeDefault` / `layerDefault` are the deterministic default. It is the first consumer `flows.engine.expected-set-deviation` has had.                                                                                                                                                                                                                                                                                                                                    |
| `Selection`          | The advisory seam that guesses which sink nodes are safe to postpone and which flows a plan is missing. `SuspectedEdge`, `BeliefSnapshot`, `Candidate`, and the `Verdict` union (`Admit` / `Defer` / `Propose`) are its schemas; `Selection` / `Service` are the tag and shape; `select` returns one verdict per candidate. `layerNoop` admits everything; `layerHeuristic` is the pure glob-match default with optional failure-history stats. `DebtEntry`, `debt`, `card`, `risk`, and `proposeReadSet` are the v2 recertification and presentation helpers; the `recertify` driver ships on `PlanScheduler`, which owns scheduling.                                        |
| `SelectionStore`     | The durable suspected-edge store. `SelectionStore` / `Service` expose `upsert`, `list`, `snapshot`, and `train`; `make` / `layer` persist through this package's migration set. `snapshot` pins the injected clock, and `train` applies the asymmetric hit/miss confidence rule without creating unknown edges.                                                                                                                                                                                                                                                                                                                                                               |
| `ArtifactGc`         | Explicit mark/sweep garbage collection for the artifact store. `ArtifactGc` / `Service` expose `gc(options)`; `GcOptions` / `GcReport` are its contract; `ArtifactGcPolicy` / `Policy` / `layerPolicy` are the opt-in policy seam (grace bound, pinned digests — configures, never schedules); `defaultGraceMs` is git's two-week prune default; `ArtifactGcError` carries `mark_failed` / `sweep_failed`; `make` / `MakeOptions` / `layer` need `SqlClient` and `@smthrs/artifacts`'s `ArtifactSweep`.                                                                                                                                                                       |
| `Inconsistency`      | `Inconsistency` / `Service` receive `CacheConflict` and return `InconsistencyVerdict`. `MakeOptions`, `make`, `makeNoop`, and `layerNoop` build receivers; `layerStrict` journals and returns `"fail"`, while `layerTolerant` journals and returns `"tolerate"`.                                                                                                                                                                                                                                                                                                                                                                                                              |
| `OwnerIdentity`      | `OwnerIdentity` / `Service` mint the `OwnerId` an incarnation fences its writes with. `make` builds one from an implementation, `makeDefault` / `layer` supply the platform default, and `layerConstant(owner)` pins a fixed identity for a test or a host that already holds a lease.                                                                                                                                                                                                                                                                                                                                                                                        |
| `RunState`           | The versioned run-state envelope schema the engine stores in each run row.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `Migrations`         | `set` is this package's own `MigrationSet`; `sets` is the composed, dependency-ordered list an engine installs; `run` and `layer` execute it through `@smthrs/database`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `Errors`             | Stable `FlowCycleDetected`, `AttemptAdmissionRejected`, and `CacheConflictDetected` errors.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

```ts
import { EngineStore } from "@smthrs/engine-store"
import { FlowRuntime } from "@smthrs/flow"
import { Effect } from "effect"

const engineLayer = EngineStore.layer({
  owner: { hostId: "worker-a" },
  journalSource: "engine-store",
  isAlive: (owner) => checkOwner(owner)
})

const program = Effect.gen(function*() {
  return yield* FlowRuntime.FlowRuntime
}).pipe(Effect.provide(engineLayer))
```

`EngineStore.layer` requires `Journal`, `RunStore`, `AttemptStore`, `CacheStore`,
`DurableEngineState`, `StepBoundary`, `Jj`, `OwnerIdentity`, and `Scope`. Run
migrations before using the SQL-backed durable state; provide
`OwnerIdentity.layer` unless the host mints its own owner tokens.

`WorkspaceSandbox` and `EffectDispatcher` are **optional** and change what a
sealed action is worth. Without a sandbox the body runs against the host
directly and `StepBoundary`'s evidence stays honestly run-local: it can only
re-measure paths it was told about, so it never claims whole-tree write
verification and `ActionPersistence` never publishes it. Compose
`WorkspaceSandbox.layerFileSystem()` and the body runs inside an isolated
workspace instead — seeded with exactly its declared read set, diffed whole at
settlement, copied back as a compare-and-set on every pre-image — and its
result becomes eligible for the shared cross-run cache. `examples/src/durable-layer.ts`
is that composition; `docs/concepts/hosts-and-capabilities.md` explains why the
transaction is not a security boundary.

`RunStore`, `AttemptStore`, `CacheStore`, and `DurableEngineState` are the
executable authorities today. Every lifecycle event is written with
`emitDurable` **inside `Journal.transact`**, the write transaction that also
carries the state transition it describes: the attempt row and its
`attemptStarted`/`attemptFinished`, the run-row CAS and its decision, the
deferred/clock row and its record, the cache provenance entry and the cache
row. The stores share one `DurableWriter`, so their writes join that transaction as
savepoints — either both halves are durable or neither is, and audit, sync, and
time travel can no longer read a hole. A crash before the commit loses the
whole unit, so an action that had already executed re-executes on adoption.
No local WAL makes a remote effect atomic, so external effects still need
idempotency keys, fencing, or compensation.

## Selection

The pluggable seam that turns recorded belief — which changed paths tend to
affect which flows — into scheduling advice for `PlanScheduler`. A guess may
suggest extra work, postpone a low-risk sink, or order the queue; it never
decides what is cached, correct, or up to date. `Selection.select`,
`card`, `risk`, and `proposeReadSet` are pure functions of caller-supplied
data, and selection verdicts never enter a step key or cache row.

`layerNoop` is the default: every candidate is `Admit`, so installing the
package changes nothing until a deployment opts into another layer.
`layerHeuristic` is the shipped deterministic layer. It considers only
live suspected edges (`validFromMs <= beliefs.pinnedAtMs`) whose `scope`
matches a changed path; a sink can be deferred only when a live edge names
that sink. A `Candidate` may also carry `stats?: { failures: number; runs:
number }`; the likelihood is `max(bestLiveEdgeConfidence, failures /
max(runs, 1))`. Stats alone never defer a sink, but failure history can keep
a flaky sink running inline where a low-confidence edge would otherwise defer
it.

**Verdicts.** `Admit` is the pass-through outcome. `Defer { edge, likelihood }`
postpones a sink to a guess-free pass; a deferred node settles as
`"deferred"`, writes no cache row, and journals
`flows.engine.selection-deferred`. `Propose { flow, edge, confidence }`
journals `flows.engine.selection-proposed` for a flow no exact dependency
reaches. Proposals are visible advice; this package deliberately does not
append them to the plan automatically.

**SelectionStore.** `SelectionStore` is the durable suspected-edge store,
tagged `flows/engine-store/SelectionStore`. `upsert(edges)` inserts or
replaces by the natural key `(scope, affects)`, `list()` returns every edge,
and `snapshot()` returns a `BeliefSnapshot` pinned at the injected clock's
current time rather than `Date.now()`. `train(observations)` updates only
matching stored edges, ignores unknown `(scope, affects)` pairs, and appends
each observation to the edge's evidence list. The training rule is asymmetric:
a hit moves `confidence` to `confidence + 0.05 * (1 - confidence)`, while a
miss halves it. A miss is a recertified deferral that failed; a hit is one
that passed. Training is one storage transaction and has no clock read inside
the rule.

**Selection debt and recertification.** `Selection.debt(runId)` is
byte-identical to v1: a `selection-deferred` record from that run opens debt, and
a same-run `node-settled` record with outcome `built`, `clean`, or `failed`
closes the matching plan key; `skipped` never closes it. v2 widens the query
with `Selection.debt(runId, { repaidBy })`: opens still come only from the
deferring run, while closes may also come from the listed repaying runs'
settlements when their plan key matches. `PlanScheduler.recertify(input)` is the
primitive for that repayment: it re-drives the compiled plan through
`PlanScheduler` under a caller-supplied fresh run id with selection full
override, then returns the repaying run id and the remaining debt computed
with `debt(deferringRunId, { repaidBy: [freshRunId] })`. The deferring run's
journal is not rewritten.

**Cards, risk, and read-set proposals.** `Selection.card(input)` renders the
plan card rows from plain data: `cached`, `run`, `deferred`, and `proposed`
rows, plus an optional trailing `risk` row. Columns are padded by at least two
spaces and the templates are fixed by tests:

```text
cached    <node>
run       <node>
deferred  <node>    fail likelihood <l> - recert <cadence>
proposed  <flow>    suspected edge <confidence> - <scope> touched
risk      <level> - <reasons joined with '; '>
```

`Selection.risk({ changed, beliefs })` is a pure annotation, never a gate: high means any live
matching edge has confidence `>= 0.7`, medium means any has `>= 0.4`, and low
means none do; reasons are named as `<scope> -> <affects> (<confidence>)`.
`Selection.proposeReadSet({ beliefs, flow, paths })` returns the workspace
paths matching the scope of any live edge whose `affects` names that flow,
deduplicated in input order. It feeds `boundaryMode: "expected"`; agent-step
wiring is outside this package.

**The laws**, pinned by tests:

1. Guesses never touch keys or the cache.
2. `deferred` is never `passed`.
3. Only sinks are deferrable.
4. Guesses add or postpone, never remove work the plan requires.
5. Training only moves confidence; it never creates edges or touches any
   journal, and a miss decays confidence faster than a hit can raise it.
6. `debt(runId, { repaidBy })` is a pure widening of v1 debt: omitted options
   preserve v1 byte-for-byte, and listed repayers only close matching plan
   keys they actually settled as `built`, `clean`, or `failed`.
7. `card`, `risk`, and `proposeReadSet` are pure functions with no service
   requirements.

**Still out of scope:** a model-backed `Selection` layer, because
`engine-store` must not grow a model dependency; CLI verbs, because this repo
has no CLI package; approval routing from risk levels, because no approval
machinery lives here; auto-appending proposals, because that design still
needs human review; and scheduled recertification cadence, because scheduling
nightly or per-merge full passes is a product/system-flow concern. The
recertification primitive itself ships here.

See the [engine-store reference](../../docs/reference/engine-store.md),
[durable execution model](../../docs/concepts/durable-execution-model.md), and
[step keys](../../docs/concepts/step-keys.md).
