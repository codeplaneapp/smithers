The durable `FlowEngine`. It claims a run before driving it, fences every write against the current owner, and persists attempts, waits, and terminal results through [`@smthrs/journal`](/api/journal), [`@smthrs/run-store`](/api/run-store), and [`@smthrs/step-cache`](/api/step-cache). It owns the durable deferred/clock tables and composes every package's migration set.

```ts
import { EngineStore, StepBoundary } from "@smthrs/engine-store"

const engine = EngineStore.layer({
  owner: { hostId: "worker-a" },
  journalSource: "worker-a"
})
```

This entry point bundles for the browser. The two host reads it once made directly, `process.pid` and `randomUUID` from `node:crypto`, enter through the [`OwnerIdentity`](#bundles-for-the-browser) service.

:::warning[Bundling is not running]
The only `DurableWriter` backing shipped here is `node:sqlite`.
:::

## Entry point

| Import                 | Source                                                                                                             | Platform         |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------ | ---------------- |
| `@smthrs/engine-store` | [src/index.ts](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/engine-store/src/index.ts) | Node and browser |

## EngineStore

[src/EngineStore.ts](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/engine-store/src/EngineStore.ts)

Required services: `Journal`, `RunStore`, `AttemptStore`, `CacheStore`, Effect's `Crypto`, `DurableEngineState`, kernel `Jj`, `StepBoundary`, [`OwnerIdentity`](#bundles-for-the-browser), and a `Scope`. [`WorkspaceSandbox`](#workspacesandbox) and its `EffectDispatcher` are optional; when present, `make` resolves them here and re-provides them onto the engine's own fiber, which does not carry the store's layer context.

`clockFireRetryPolicy` is optional and defaults to exponential from 100ms capped at 30s, forever, which is the same option shape as the engine's `suspendedRetryPolicy`.

## API reference

This page is the public API reference for the journal-backed `FlowEngine` composition, deferred/clock state contract, and hermetic boundary contract. The composition bundles anywhere; the shipped storage beneath it is still SQLite-on-Node.

### Bundles for the browser

`@smthrs/engine-store` is a **browser entry point**, and the repository's browser gate treats it as one. The two host reads it once made directly, `process.pid` and `randomUUID` from `node:crypto`, moved behind the injectable `OwnerIdentity` service (`packages/smithers/flows/engine-store/src/OwnerIdentity.ts`), which closed issue #114: the default reads a process id off `globalThis` where the platform has one and draws an incarnation number from `Random` where it does not, and `layerConstant` pins the whole token. Everything it composes, `@smthrs/crypto`, `@smthrs/flow`, `@smthrs/journal`, `@smthrs/run-store`, `@smthrs/step-cache`, `@smthrs/database`, `@smthrs/kernel`, and `@smthrs/engine`, is browser-bundleable too. Bundling is still not running: the only `DurableWriter` backing shipped here is `node:sqlite`, so do not describe the durable engine as browser-_ready_ until a browser SQL client layer exists. `pnpm run browser` bundles this entry point and fails the build if it regresses. See [platform support](/docs/reference/api/#platform-support).

### `EngineStore`

```ts
const layer = EngineStore.layer({
  owner: { hostId: "worker-a" },
  journalSource: "engine-a"
})
```

`Options` contains `owner.hostId`, `journalSource`, and the optional `isAlive` and `clockFireRetryPolicy`. `clockFireRetryPolicy` is the redispatch `Schedule` for a durable clock whose fire failed, defaulting to exponential from 100ms capped at 30s, forever. It is the same option shape as the engine's `suspendedRetryPolicy`: the built-in behavior is the default, and a deployment supplies its own rather than patching the store. `make(options)` returns a `FlowRuntime` service, the port `@smthrs/flow` declares. `layer(options)` provides both `FlowRuntime` and `FlowEngine.SnapshotBoundary`.

#### Liveness and reclaim

`isAlive` decides whether a run whose lease has expired may be stolen. Answering `true` refuses the takeover. The default is `Ownership.leaseLiveness(Ownership.heartbeatStaleAfter)`: the owner counts as alive while its persisted `heartbeat_at_ms` is younger than the staleness cutoff, and gone once it is not. That is the only evidence every host has, and it is what lets a fresh process reclaim the runs of an owner killed with SIGKILL without any application code. The steal it admits carries `lease-expired` evidence, which `RunStore.steal` re-checks against the row inside the same write, so a claimant that lies about the lease loses the compare-and-swap.

A deployment that knows more supplies its own check and refuses the takeover for longer. Such a check is a `process.kill(pid, 0)` probe on the owner's host, or an orchestrator that reports pod liveness. Guard a pid read with `Ownership.sameHostIncarnation(owner, claimant)`: a pid names a process only in its own host's namespace. A supplied check receives the recorded owner and a `LivenessContext` of `{ claimant, heartbeatAtMs, nowMs }`.

The journal says which answer was used. A refusal records `steal-refused-owner-alive` with `evidence: "lease-fresh"` (the lease was still inside the window) or `evidence: "probe"` (the supplied check answered for the owner); a takeover records `stolen-and-activated` with the evidence kind it wrote: `lease-expired`, `same-host-pid-dead`, or `cross-host-unreachable-stale`.

A refusal is journaled once, not once per sweep tick. The record is addressed by the run, the refused owner, the lease it was refused against, and the evidence that refused it, and it carries source sequence 0, so the journal's first-writer admission collapses every repeat about an unchanged lease into the one record. The evidence is part of the address because one lease can be refused twice for different reasons: a wake arriving while the owner is still pulsing is refused by the lease (`lease-fresh`), and the same owner, alive but stalled past the window, is refused by the probe (`probe`). Both records stand.

The driver also stops re-probing a run it was just refused. Each refusal defers the run for two heartbeat ticks, doubling per consecutive refusal against the same lease up to `heartbeatStaleAfter`, and the stale-running sweep reads past exactly the rows it is going to skip so its batch of 64 keeps advancing. Without that, the oldest stale rows sort first every second and a run behind them is never arbitrated at all. A deferral is forgotten as soon as its row leaves the stale window, when the owner resumed heartbeating, the run was stolen, or the run settled, so a fresh stall under a new lease is probed on the first tick that sees it rather than waiting out a backoff it did not earn.

Required services are `Journal`, `RunStore`, `AttemptStore`, `CacheStore`, Effect's `Crypto`, `DurableEngineState`, kernel `Jj`, `StepBoundary`, `OwnerIdentity`, and `Scope`. A composition failure is an unmet `Requirements` type at compile time, so there is no runtime composition error to handle.

The engine stores a versioned state envelope in each run row, fences run and attempt ownership, replays encoded exits, and writes engine decisions to the journal. Cache addresses are the injected `Sha256` transformation of the step key, not the raw `key1_…` value.

Durable cancellation is observed, not just recorded: while a run executes, the driver polls `cancel_requested_at_ms` on the heartbeat cadence and cancels the run (interrupting the flow fiber) when another process has called `RunStore.requestCancel`. Terminal transitions are additionally guarded with `{ cancelRequested: "absent" }` inside the ownership CAS, so a request that races past the last poll turns finalize into a cancellation instead of a `completed`/`failed` write.

The driver's periodic sweep (heartbeat cadence) re-drives three durable shapes: parked runs whose cancellation was durably requested, runs parked with reason `released` (interrupt-released by shutdown, issue #39), and stale-running rows left by a hard-killed owner (issue #53): each re-enters the ordinary claim/steal/activate path. A wake for a flow the sweeping process has not registered is not dropped silently: the driver logs a once-per-run structured warning (run id + flow name) and leaves the durable waiting row parked, so any process that registers the flow still reclaims the run (issue #62).

Every engine-store lifecycle journal write, run decisions, attempt started/finished, hard violations, snapshot identity, cache provenance, deferred completions, clock schedules, interruption records, and the `Inconsistency` cache-conflict record, takes the journal's durable channel (`emitDurable`), so a saturated lossy queue can never drop one. Attempt lifecycle writes additionally pass the owner, fencing the append on the run's persisted ownership: a reclaimed (zombie) owner fails with `fence_lost` and self-interrupts instead of appending.

### `DurableEngineState`

The service addresses deferreds by flow/execution/deferred name and clocks by flow/execution/clock name. It exposes:

- `deferred` and first-writer-wins `completeDeferred`
- `clock`, first-writer-wins `scheduleClock`, and `completeClock`
- `dueClocks(nowMs)`
- owner-fenced `park`, idempotent `wake`, `waiting`, and sweeper-ordered `waitingRuns`: the `WaitingRunsFilter` supports `reason`, `dueBeforeMs`, and a `cancelRequested` predicate over `flows_runs.cancel_requested_at_ms`, so sweepers fetch only actionable rows instead of scanning every parked run (issue #68)
- `staleRunningRuns(staleBeforeMs)`: run ids still `running` whose heartbeat froze before the horizon; the driver's periodic sweep re-drives these through the claim/steal path so a hard-killed owner (SIGKILL, OOM) cannot strand a run (issue #53)
- `recordRunParent(childId, parentId)`, durably records a parent edge in the run DAG (`flows_run_parents`), first-writer-wins per pair. The cycle check is **inside the same write transaction** as the insert: the child→parent chain is walked over the durable edges and on a hit the transaction rolls back and the call fails with the typed `RunParentCycleError`, so a rejected edge leaves no durable trace, and of two concurrent writers whose edges jointly close a cycle exactly one fails (issues #29/#40/#54/#55/#56). The driver maps this error to `FlowCycleDetected` and records the edge before creating the run row, so no `state_json` `parentExecutionId` can outlive a rejected edge. Edge insert and run-row creation run inside **one** storage transaction (`DurableEngineState.transaction`), so a crash between them cannot leave a durable orphan edge for a run that was never created (issue #80). Serialized write transactions are a documented requirement of the `DurableWriter.write` contract, not a SQLite artifact, a Postgres-backed implementation must use `SERIALIZABLE` (issue #74)
- `runParents(childId)`: the recorded edges, oldest first (`seq` is ordering-only)
- `removeRunParentsForRun(runId)`: deletes every edge naming the run as child **or** parent, for lanes that clear edges without deleting the run row. Because `flows_run_parents` deliberately has no FK to `flows_runs`, GC is additionally enforced in the database: an `AFTER DELETE` trigger on `flows_runs` prunes the deleted run's edges in the same transaction, so a lane that never calls this hook still cannot leave ghost edges in a future cycle walk (issues #66/#81)

The run driver populates the waiting taxonomy on the execution path: a run
that suspends parks before its `suspended` transition: reason `timer` with
the earliest pending clock deadline as `wakeAt` when a durable clock is
outstanding, reason `event` otherwise, and every resume wakes (clears) the
waiting payload when the run re-enters `running`. `waitingRuns` and the
waiting-row partial index therefore match real suspensions, not only
rows written through the store API directly.

Outcome unions distinguish newly written, existing, completed, and missing
rows. `make` and `layer` provide SQL persistence through `DurableWriter` and Effect's `SqlClient`;
`makeMemory(options?)` and `layerMemory` are deterministic in-memory
implementations that, given a `runs` lookup, enforce the same
`park`/`wake`/`scheduleClock` ownership fences as the SQL layer: both are
pinned by one shared contract suite
(`packages/smithers/flows/engine-store/test/contract/DurableEngineStateContract.ts`).
Clock creation is fenced against the active run owner. Deferred and clock
completion use first-writer and compare-and-set admission before the existing
claim-gated wake path. A durable clock whose fire fails transiently is
redispatched with capped exponential backoff (Temporal timer-queue
semantics) rather than being lost until process restart.

### `StepBoundary`

<a id="stepboundary"></a>

`FileBoundary` from `@smthrs/flow`'s `Action` namespace contains `readSet`, `writeSet`, and `boundaryMode` (`hard` or `expected`). A service implements:

```ts
interface Service {
  prepare(descriptor: FileBoundary): Effect<PreparedBoundary, UnsupportedBoundary, Crypto>
  settle(prepared: PreparedBoundary): Effect<BoundaryEvidence, UndeclaredWrite | UnsupportedBoundary>
  replayOutputs(evidence: BoundaryEvidence): Effect<void, UnsupportedBoundary | BoundaryCorruption | MissingArtifact>
}
```

`BoundaryEvidence` contains declared outputs, a diff identity, optional expected-set deviation, and optional `wholeTreeWritesVerified: true`. A hard undeclared write fails with `UndeclaredWrite`; expected mode records a deviation. Cross-run cache admission requires the explicit whole-tree proof.

`MissingArtifact` is the one replay refusal a shared artifact tier can repair, the bytes are simply not on this host, so it is a distinct tag from a corrupt address or a host that refused outright. `referencedDigests(evidence)` names the digests evidence references rather than inlines; that is the set `ArtifactSync` publishes and fetches.

`make(service)` wraps an implementation. `layer` is the filesystem-backed production boundary over the kernel `FileSystem` seam and the `@smthrs/artifacts` `ArtifactStore`, which owns the blob mechanics (content addressing, atomic publication, digest verification, dedupe); what stays here is the policy that decides which outputs become blobs at all, the `maxInlineBytes` / `maxTotalInlineBytes` inline-versus-spill budgets. Concretely: `prepare` measures the declared read set's real digests, `settle` detects declared reads mutated outside the declared write set and captures the write set's post-state as materializable outputs, and `replayOutputs` re-materializes them. It cannot detect writes elsewhere in the tree, so it never claims the whole-tree proof itself, that claim now comes from running the body somewhere else, which is [`WorkspaceSandbox`](#workspacesandbox). A composition with a boundary but no sandbox keeps the old, honest outcome: run-local results only. `layerTest(options?)` is deterministic and supports changed-path/deviation/replay/`readSnapshot` assertions, but it does not enforce a real sandbox.

### `WorkspaceSandbox`

<a id="workspacesandbox"></a>

The functional workspace transaction: a sealed action's body runs in an isolated workspace and _returns_ its writes rather than performing them.

```ts
interface Service {
  execute<Output, Error>(
    execution: Execution<Output, Error>
  ): Effect<ExecutionResult<Output>, Error | WorkspaceError, Crypto>
  materialize<Output>(accepted: Accepted<Output>): Effect<void, MaterializationConflict | WorkspaceError, Crypto>
}
```

`execute` is speculative and never touches the host. It seeds the transaction with exactly the declared read set, an undeclared file is simply not there, which is the strong enforcement tier, serves it through both the `Workspace` tag and a re-rooted Effect `FileSystem`, and diffs the whole map at settlement. An execution whose observations contradict its declaration is `Invalidated` in hard mode, and that shape carries provenance and violations _only_: there is no accessor for the candidate output, files, or queued effects.

`materialize` is the single host write and is all-or-nothing: every `FileChange.beforeDigest` is compared against the live host before a byte lands, so a bundle whose base moved is refused whole with `MaterializationConflict` and `ActionPersistence` rebases a bounded number of times. `beforeDigest` describes what is really on the host, including for a declared output the body never declared as a read: the `Host.baseline` seam is what supplies it, because "absent from the seed" is not "absent from the host".

`QueuedEffect`s are deliberately not dispatched inside the transaction: a speculative send has already reached the world when its execution turns out invalid, and reaches it twice when a copy-back loses a race. The optional `EffectDispatcher` stage runs after copy-back settles, deduplicated by idempotency key. The journal records `diff-bundle-captured` and `copy-back-settled`.

`makeMemory` is the deterministic, browser-safe conformance implementation (it seeds the whole tree, so an undeclared read is observable); `makeFileSystem` / `layerFileSystem` back the transaction with the kernel `FileSystem`, the kernel `Workspace` root, and `@smthrs/artifacts` for products too large to carry inline. Both are `makeHosted` over one `Host`, so the transaction, the diff, the violation check, and the provenance cannot drift between them.

It is a **deterministic transaction model, not a security boundary**. A body reaching the host through a service the transaction does not seed is outside it; denying that ambient access is the VM/`SandboxProvider` story in [`@smthrs/sandbox`](/api/sandbox). The human diff-review gate is not implemented and a settled bundle is applied without it (a known limitation of this release), and the transaction's `FileSystem` surface is deliberately partial.

### `PlanScheduler`

<a id="planscheduler"></a>

The node scheduler: it drives a persisted [`@smthrs/plan`](/api/plan) `Plan` to completion. `record` persists generation 0 and journals `plan-recorded`, `append` persists the newest generation and journals `subgraph-appended`, and `run` walks the graph.

```ts
interface Service {
  record(plan: Plan): Effect<RecordResult, SchedulerError, PlanStore | Journal>
  append(plan: Plan): Effect<void, SchedulerError, PlanStore | Journal>
  run(plan: Plan): Effect<Report, SchedulerError, Requirements>
}
```

Ready nodes dispatch through the same `internal/ActionPersistence` seam every action uses, so the shared step cache, [`WorkspaceSandbox`](#workspacesandbox)'s execute→materialize transaction, attempt rows, and the fenced journal all apply unchanged. The dispatch key folds the plan-time node key together with the boundary the host measured immediately before dispatch: two runs whose input files differ declare the same graph, and serving one the other's result is exactly the staleness the boundary exists to prevent.

Skyframe's `AbstractParallelEvaluator` is the prior art, with two deliberate deviations. There is **no reverse-dependency index and no invalidating node visitor**, because a node is dirty iff the key it would dispatch under moved and the dispatch-time recheck already computes that. And dependency discovery is a **wavefront** rather than Skyframe's restart-based discovery, because the plan declares its edges before anything runs.

Each node settles as one of four outcomes, `built`, `clean` (the shared cache served it and nothing ran), `failed`, and `skipped` (its cone failed, or `stop-merge` stopped it), journaled as `node-settled`. Admission is the middle limit only: `concurrency.steps` caps leaf execution and `concurrency.agents` caps the agent subset within it. Both default to unbounded and both floor at one, because a cap of zero admits nothing and a round that admits nothing settles nothing. Ready work is ordered by declared `priority` plus one point per round waited, so priority changes latency without permitting starvation.

Source paths, read by the plan, written by nothing in it, are measured **once** before the first dispatch and pinned for the whole run; produced paths are measured after their producer settles. That is the torn-run rule: a rebase re-observes our own outputs, never the world.

The runtime conflict strategies ride the plan's pair annotations. **delay/rebase** holds the dependents and re-executes against the newly recorded base, the re-measure re-keys, so it is a new attempt rather than a retry of one identity, journaled as `node-invalidated`, bounded by `rebaseLimit`. **stop/merge** stops the loser and appends a merge node to the _same_ plan as an ordinary elaboration, with no rebase budget of its own, because a lane that loses a landing race restarts or fails rather than rebasing. A conflict neither absorbs goes to [`Reconciliation`](#reconciliation).

`NodeExecutor` is the DI seam that turns a `NodeInput` into work: the scheduler owns identity, admission, caching, and journaling, and deliberately owns nothing about what a node _means_.

### `Reconciliation`

<a id="reconciliation"></a>

The pluggable seam for when the world disagrees with the declaration. It is the **first consumer** `flows.engine.expected-set-deviation` has ever had: the emitters shipped with isolated execution and nothing read them.

```ts
interface Service {
  onDeviation(deviation: Deviation): Effect<Verdict>
  onConflict(conflict: Conflict): Effect<Verdict>
}
```

Pluggability is dependency injection at the owning seam, per the repository's extension doctrine; there is no hook kernel. `layerDefault` installs a deterministic verdict function in the vault's order of preference: **`Reorder`** when every undeclared path is one another plan node declares it writes (a real dependency the declaration missed, made explicit), **`FactorOut`** when another node in the same run deviated on exactly the same paths (content addressing collapses two identical extracted steps to one key by itself, so the verdict is a record and a hint), and **`Fail`** otherwise, because a deviation nothing explains is the case the vault calls genuinely wrong. A conflict the runtime strategy could not absorb always fails here: choosing a winner between two landings is a semantic judgement this default does not have the material to make.

The scheduler attributes every deviation on a journal page before judging any of it, so two steps that produced the same undeclared paths both see each other: deviating identically is a symmetric fact, and which of the pair the journal happened to list first must not decide the verdict.

A model-backed reconciler is a different `Layer`. It lives in the agent packages; this package has no model dependency and must not grow one.

### `Selection`

<a id="selection"></a>

The advisory scheduler seam. `Selection.select` may return `Admit`, `Defer`, or `Propose` verdicts for sink candidates and missing flows; it never changes a step key, cache row, or correctness decision. `SuspectedEdge` is the belief shape (`scope`, `affects`, `confidence`, `validFromMs`, `evidence`), and `BeliefSnapshot` pins the edge set at plan time.

`layerNoop` admits everything. `layerHeuristic` is pure glob matching over live edges (`validFromMs <= pinnedAtMs`): a matching edge supplies likelihood, a sink can defer only when a live edge names it, and a `Candidate.stats` failure ratio raises likelihood so flaky sinks stay inline. Stats alone never defer. A model-backed layer is out of scope because `engine-store` must not depend on a model.

`Selection.debt(runId)` is the v1 same-run fold: `selection-deferred` opens by plan key, and `node-settled` with `built`, `clean`, or `failed` closes; `skipped` does not. `Selection.debt(runId, { repaidBy })` widens only the close side, accepting matching settlements from explicitly named repaying runs while leaving omitted options byte-identical to v1. `PlanScheduler.recertify(input)` re-drives the compiled plan through `PlanScheduler` under the caller's fresh run id with full-selection override, then returns that repayer and the remaining debt computed with `repaidBy`.

`Selection.card(input)` is a pure plan-card renderer for `cached`, `run`, `deferred`, `proposed`, and optional `risk` rows; its row strings are test-pinned. `Selection.risk({ changed, beliefs })` is a pure annotation, never a gate: `high` at confidence `>= 0.7`, `medium` at `>= 0.4`, otherwise `low`, with reasons named `<scope> -> <affects> (<confidence>)`. `Selection.proposeReadSet({ beliefs, flow, paths })` returns matching workspace paths for live edges whose `affects` names the flow, deduped in input order; wiring that into agent steps is out of scope.

Still out of scope: CLI verbs because no CLI package exists here, approval routing because approval machinery is not in this package, auto-appending proposals because the design needs human review, and scheduled recertification cadence because cadence is a product/system-flow concern rather than the store primitive.

### `SelectionStore`

<a id="selectionstore"></a>

The durable suspected-edge store, tagged `@smthrs/engine-store/SelectionStore`. `make` and `layer` follow the sibling store idiom and install through this package's `MigrationSet`.

`upsert(edges)` inserts or replaces by `(scope, affects)`, `list()` returns every edge, and `snapshot()` returns a `BeliefSnapshot` pinned at the injected clock's current time, never `Date.now()`. `train(observations)` updates only matching edges in one transaction, ignores unknown pairs, appends every observation to evidence, and uses the asymmetric rule: hit -> `confidence + 0.05 * (1 - confidence)`; miss -> `confidence * 0.5`. Training never creates edges and never writes journal records.

### `ArtifactSync`

<a id="artifactsync"></a>

The two-tier artifact protocol, and the seam a shared-cache composition injects into. `makeLocal()` is the default when the tag is absent: publish is a no-op and hydrate reports nothing arrived, so a purely local engine pays nothing. `make({ local, remote })`, or `layer(remote)`, which takes the local tier from the `ArtifactStore` tag, implements the real thing:

- `publish(digests)` runs `findMissing` on the shared tier, uploads what is missing, and re-probes to confirm. `ActionPersistence` calls it immediately **before** the transaction that records the cache entry, and never inside it. This is Bazel's REAPI ordering constraint (`UploadManifest.java:630-633`): an action result is uploaded after every blob it refers to, because a result accessed before its blobs are present cannot be validated. A publication that cannot make the artifacts durable fails with `ArtifactPublicationFailed`, and the **shared** entry is withheld.
- `hydrate(digests)` establishes that this host can resolve every referenced artifact, reporting whether the replay is now worth retrying. It never fails a run: a shared tier that is down must not stop work that can simply be done. How eagerly it materializes is the `downloadPolicy` option on `make` and `layer`.

### `ArtifactGc`

Collection never runs automatically. `gc()` is an explicit verb, and the mark is fail-safe: a root row carrying boundary evidence this build cannot decode aborts the collection rather than contributing nothing. Attempt checkpoints are also live roots, with digest-shaped strings retained conservatively. See [Sweep unreferenced artifacts](/docs/guides/retention/#4-sweep-unreferenced-artifacts) for the algorithm and its concurrency argument.

### `CacheSync`

<a id="cachesync"></a>

The second half of the ordering constraint: the shared step-result tier's `put`, run **after** the transaction that made the local row durable. `makeLocal()` is the default when the tag is absent. `make({ remote })`, or `layer(remote)`, publishes to a remote `CacheStore`, typically `RemoteCacheStore`.

It is a separate seam from the `CacheStore` tag because of _where_ the local row is written. `ActionPersistence` commits the cache row and the journal record explaining it in one `DurableWriter` transaction, and nothing that is not storage work may be held across one: a `CacheStore` whose `put` also wrote a shared HTTP tier would put a network round trip inside that transaction, blocking every other writer for its duration and rolling the local row back whenever a _shared cache_ was unreachable. So the local put stays inside and the shared put becomes this service. Compose it with `CombinedCacheStore` in `"deferred"` publication mode, which is the mode that leaves the shared write here; lookups stay read-through either way.

Neither publication step can fail a run. Both run after `attempts.finish`, so the result is already durably recorded on this host, and failing a completed run because an optional accelerator is unreachable trades a real result for an unavailable one. A refusal withholds the shared copy, never the local row, and journals a `cache-provenance` record with `action: "unpublished"` carrying the stage (`artifacts` or `entry`) and the reason. That is the same "visible, not silent" treatment an unverified read set gets (issue #106); a missing shared entry is explainable from the journal rather than inferred from its absence.

#### `ArtifactSync.DownloadPolicy`

How eagerly a replay materializes the artifacts it references. Bazel's `RemoteOutputChecker` dial at the seam that owns the decision.

The policy is declared on the shared tier as `RemoteArtifacts.Options.downloadPolicy` and `ArtifactSync.make` reads it from the store it was handed, so one deployment setting reaches both seams. An explicit `downloadPolicy` on `make` or `layer` overrides it.

| Policy          | `hydrate` behavior                                                                                                                                                                              |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `all` (default) | Downloads every referenced artifact into this host's store while admitting the replay. Every later read is local, and a shared tier that goes down afterwards costs nothing.                    |
| `toplevel`      | Downloads nothing. One batched `findMissing` establishes that the shared tier can serve what is missing, and `CombinedArtifacts.get` fetches and writes back the blobs a reader actually reads. |
| `minimal`       | The same probe and the same zero downloads here; `CombinedArtifacts.get` then serves without writing back, so this host never accumulates other machines' artifacts.                            |

The two lazy policies are only sound when the store the replay reads through can reach the shared tier, which means `CombinedArtifacts` with the same remote tier. Under a purely local `ArtifactStore` an admitted lazy replay would later read an artifact this host never fetched. A tier that refuses the probe is indistinguishable from one that holds nothing, so the replay is refused either way and the step executes.

### Cache admission

EngineStore admits a cache record only when the action is sealed, the boundary is hard, no deviation occurred, and the evidence explicitly carries `wholeTreeWritesVerified: true`. Older evidence and boundaries that observe declared paths only are conservatively refused. Under the production composition that proof comes from [`WorkspaceSandbox`](#workspacesandbox): the body ran in an isolated workspace, so a write outside the declared set is a map comparison rather than an inference, and `ActionPersistence` sets the flag itself, or, when the whole-tree diff shows a deviation the declared-read scan would have missed, records that deviation and withholds the entry. Only a content-key record has an address another run can reproduce; an ordinal-key record remains run-local. A cache hit is verified before it is served (issue #90): the store calls `prepare` and compares the descriptor's declared `readSet` against the `readSnapshot` the host measured. Reuse happens only when every declared read still matches, reads the host reports but the declaration never claimed are ignored, while a declared path that is missing or has a different digest refuses the hit, journals a `cache-provenance` record with `action: "stale_read_set"`, and falls through to a real execution. That is Skyframe's dirty-check invariant; the key alone only detects a _changed declaration_, not a stale one. A verified hit calls `replayOutputs` before returning the stored result. When that refuses with `MissingArtifact`, the normal first answer for a row recorded on a machine whose artifacts this one has never seen, the dispatch hydrates from the shared tier and retries the replay exactly **once** before falling through to a real execution; a second failure means the tier cannot serve it either, and executing is strictly better than looping.

Replaying a succeeded attempt row also converges the cache: if a crash landed between `attempts.finish` and `cache.put`, the restarted executor re-records the sealed completion (with fresh cache-provenance) instead of leaving the cache permanently behind the journal. A divergent first-recorded row still surfaces through the `Inconsistency` receiver, strict by default.

A persisted `failed` attempt row replays by rethrowing the persisted domain failure, never by readmission, so `AttemptAdmissionRejected` marks only genuinely mid-flight (`running`) rows. The `Fail` errors were schema-encoded before persistence, so their `_tag` survives the JSON round trip and `RetryPolicy` non-retryable matching applies on replay (issue #59). The composition also implements the engine's `actionLatestAttempt` (attempt counter resumes from the persisted sequence) and degrades `actionRetryOrigin` to the earliest surviving attempt row when a retention job pruned attempt 1 (issue #69).

See [Run durably over SQLite](/docs/tutorials/first-flow/#6-run-durably-over-sqlite) and [Content addressing](/docs/concepts/content-addressing/).

### Stable errors

Every `code` literal exported through `Errors` is part of the public API. Consumers may switch on `code` or `_tag`.

### Migrations and internal scheduling

`@smthrs/engine-store` owns `flows_deferred_completions` and
`flows_clock_deadlines`: the persisted `DurableDeferred`/`DurableClock` state
`internal/DeferredPersistence` operates and no other package reads, and
reserves migration id block `3000`. Because it composes every storage package,
`Migrations.sets` is also the complete durable engine schema in dependency
order (journal, run store, step cache, then its own) and `Migrations.layer`
installs all of it. See [`@smthrs/database`](/api/database) for how the
namespaced sets compose without colliding.

`internal/RunCoordinator` lives here rather than in a storage package because
it is in-memory scheduling, not persistence: `make({ drain })` deduplicates
in-process work by key and exposes `active`, `run`, `wake`, and `interrupt`
around scoped fibers. `RunDriver` is its only consumer. It is not distributed
ownership; that is [`@smthrs/run-store`](/api/run-store)'s `RunStore`. The shape
is adapted from opencode's `packages/smithers/flows/core/src/session/run-coordinator.ts`,
which also lives in the session layer.

### Test compositions

`test/TestStores` builds every durable engine service over one database, with
this package's composed migration set already installed. `layer` uses a private
in-memory database and keeps `SqlClient` to itself, which is what a case that
only needs an engine wants. `layerAt(filename)` takes the database by name and
re-exports the connection alongside `DurableEngineState`, which two other
shapes need:

- adding another SQL-backed service (a control runtime, say) over the same
  database as the engine, and
- pointing two independently constructed bundles at one FILE. That gives two
  connections, two engines, and no shared object graph, which is what a second
  process actually has. `:memory:` gives each connection its own private
  database, so it cannot prove anything durable across compositions.
