---
description: "The rules the durable driver enforces, the reasoning behind each one, and the tests that pin them."
---

# Internal details

This page is for people changing the engine. It documents the rules the durable driver enforces, the reasoning behind each one, and the tests that pin them. Nothing here is required to write a flow.

## Write-ahead atomicity

The problem: executable state lives in `RunStore`, `AttemptStore`, `CacheStore`, and `DurableEngineState`, while the account of what happened lives in the journal. If those commit separately, a crash between them leaves durable state the log does not explain, and audit, sync, and time travel can no longer trust the log.

The rule: every lifecycle entry commits in the same write transaction as the state transition it describes. `Journal.transact` opens that transaction. Every store writes through the same `DurableWriter`, so their writes join it as savepoints. Either both halves are durable or neither is.

The pairs that are closed today:

| State write | Lifecycle entry |
| --- | --- |
| attempt admission | `attemptStarted` |
| compensable pre-image patch | `snapshotIdentified` |
| `attempts.finish` | `attemptFinished`, plus `hardViolation` or `expectedSetDeviation` |
| `CacheStore.put` | the cache-provenance append |
| run-row compare-and-swap | `transitioned`, `quarantined`, `interrupt-released`, or `claimed-and-activated` |
| cancel transition and waiting-row clear | `interrupted` |
| deferred completion row | `deferredCompleted` |
| clock row | `clockScheduled` |

Three consequences to design around:

- Publication is deferred. An entry reaches `changes`, `stream`, and the in-process producer index only after the outermost COMMIT. A subscriber never observes an entry that later rolls back, and a rolled-back producer identity stays re-emittable rather than deduplicating against a sequence that does not exist.
- The unit is all-or-nothing. A crash before COMMIT loses the whole unit, so an action body that had already run re-executes on the next drive. Temporal makes the same trade when it submits mutable state and its event batches as one persistence request.
- Nothing that is not storage work may run inside the transaction. No flow bodies, no host calls, no jj snapshots, no boundary prepare or settle, no lossy `flush`.

:::warning[A local commit is not remote atomicity]
No journal write makes an external effect atomic with it. Effects outside the database keep needing idempotency keys, fencing tokens, or a declared compensation.
:::

Pinned by `packages/engine-store/test/WalAtomicity.test.ts`, which drives `Notifying.wrap` at every closed interstitial, crashes there, restarts, and asserts journal and state equivalence.

## Claims and fencing

A driver never starts on a status read. It reads an exact `RunSnapshot`, performs a claim compare-and-swap against that snapshot, activates the claim, and only then moves the row to `running`.

| Operation | Guard |
| --- | --- |
| `claim` | the observed snapshot still matches |
| `claimAndOwn` | the snapshot matches; replacing a different running owner also needs liveness evidence |
| `activate` | the claim generation matches |
| `abandonClaim`, `recoverClaim` | the claim generation matches |
| `heartbeat` | owner identity matches |
| `transitionOwned` | owner identity matches, plus any caller guard |
| `steal` | the snapshot matches and liveness evidence is supplied |

Losing the fence interrupts the driving fiber, so two processes cannot persist terminal state for one run. Attempt writes carry the same fence: a zombie owner appending attempt lifecycle self-interrupts on `fence_lost`.

All start and wake paths enter the same keyed `RunCoordinator`, so concurrent callers in one process either join one local drain or race through the same database claim.

## Heartbeat and takeover

| Constant | Value | Role |
| --- | --- | --- |
| `heartbeatInterval` | 1 second | how often an owner refreshes the fence |
| `heartbeatWriteTolerance` | 19 seconds | how long an owner whose heartbeat writes fail keeps working |
| `heartbeatStaleAfter` | 30 seconds | how old a heartbeat must be before a peer may steal |
| `heartbeatSkewAllowance` | slack | clock-skew tolerance in the comparison |

The tolerance is eleven ticks shorter than the steal cutoff. An owner that cannot write its heartbeat is therefore always interrupted before any peer is allowed to take its run, which is what makes the two-sided fence safe rather than merely likely.

Elapsed wall time alone never proves an owner is dead, so `steal` demands `Ownership.LivenessEvidence` and `EngineStore.Options.isAlive` is supplied by the application.

:::warning
These are protocol defaults. A deployment that cannot answer the liveness question in 30 seconds should say so rather than assume.
:::

Two sweeps run on the heartbeat cadence. One enumerates actionable parked rows, filtered by reason `released` plus a cancel-requested predicate, so it does not scan every parked run. The other enumerates stale-running rows and re-drives them through the claim path, so a hard-killed owner does not strand its run. Both are sandboxed: a transient defect escaping the sweep is logged and retried on the next tick rather than killing delivery for the process lifetime. A wake for a flow the sweeping process never registered logs a once-per-run structured warning and leaves the row parked.

## Retry origins

A retry policy carries an `expirationMs` schedule-to-close bound. Measuring it from the current clock would restart the budget every time a run parked or a process died, which turns a bounded budget into an unbounded one.

The driver instead exposes `actionRetryOrigin({ key })`, reading the durably persisted first-attempt start. The wall-clock budget then survives park, resume, and process death. The attempt counter resumes from `actionLatestAttempt`, so the backoff ladder is not re-slept.

Degradation is explicit. When attempt 1 has been pruned, the origin falls back to the earliest surviving attempt row. Only when no row survives does the budget restart from the current clock, and that case logs a warning.

The verdict is durable too. A persisted `failed` attempt row replays by rethrowing the persisted domain failure rather than `AttemptAdmissionRejected`, so a non-retryable failure matches on resume without an extra dispatch.

## Cache admission

A cache key says an output is a function of some declarations. It cannot see a hidden file read or an undeclared network call. So the key alone never admits a row to the shared cache. Admission requires all of:

1. action tier `sealed`;
2. `metadata` that decodes as `FileBoundary`;
3. `boundaryMode: "hard"`;
4. `prepare` and `settle` both succeeding;
5. no expected-set deviation in the settle evidence;
6. `wholeTreeWritesVerified: true` in that evidence.

The filesystem boundary measures declared read sets and materializes declared outputs, and it cannot detect writes outside the declared sets. It therefore does not attest whole-tree verification, and its evidence is deliberately not admitted. A stronger boundary, such as a jj-diff-backed implementation, is Planned.

One near-miss is journalled rather than silent: when every gate passes but the read set fails verification, the run continues on its own result and a `cache-provenance` entry with action `unverified_read_set` explains the missing row.

`CacheStore.put` is first-writer-wins. A `Conflict` is journalled as `flows.engine.cache-conflict` and handed to `Inconsistency`, whose unwired core default is strict: journal, then fail the run with `CacheConflictDetected`.

When `replayOutputs` fails for a shared-cache row, `ActionPersistence` classifies a `StepBoundary.BoundaryCorruption` as recorded-evidence corruption. It journals `replay_failed` with `reason: "corruption"` and sends the evidence to `Inconsistency`; strict mode fails the replay with `CacheCorruptionDetected`, while a tolerant verdict evicts the row and falls through to a fresh execution. A `MissingArtifact` is hydrated from the shared tier and replayed once before this classification. Other replay failures are host refusals, journalled with `reason: "host"`, and fall through to a real execution. A succeeded attempt keeps its durable outcome: corrupt boundary evidence is quarantined, strict mode parks with `AttemptEvidenceQuarantined`, and a tolerant verdict returns the recorded outcome without republishing the corrupt evidence or re-executing the action.

## Replay determinism

Handlers are not serialized. A resume claims the run, decodes the original payload, invokes the registered handler from the top, returns stored results at known boundaries, and dispatches at the first boundary with no recorded state.

Control flow is re-evaluated rather than restored from a stack snapshot, so code between boundaries must produce the same control flow given the same payload and recorded values.

:::danger[Unsafe in a flow body]
`Date.now()`, unseeded randomness, global mutable state, unordered external reads, environment variables read inline, and host operations outside an action. The output of a recorded action may be nondeterministic, because replay safety comes from recording its encoded exit.
:::

Durability attaches at boundaries: `Action`, `DurableDeferred`, durable clocks, durable queues, child flow execution, and explicit journal or time-travel effect boundaries. Nothing between them is journaled.

:::note[Two meanings of replay]
`EngineStore` replay re-runs a registered handler. `TimeTravel.inspect` is read-only: it folds committed entries into a projection and never invokes a handler or dispatcher.
:::

There is no flow-source digest. What decides reuse after a code edit is action identity: a changed cache key input produces a new result, an unchanged one reuses the old, changed control flow around ordinal actions can remap ordinals, and changed schemas can make stored payloads or results fail to decode as a defect.

## Run cycle detection

`recordRunParent` inserts the durable parent edge and walks the child-to-parent chain inside one write transaction, rolling back and failing with `RunParentCycleError` on a hit. There is no in-process gate, no cross-owner arbitration, and no withdrawal protocol.

The driver records the edge before creating the run row, so a rejected request leaves no durable trace, and both writes happen in one storage transaction, so a crash between them leaves no orphan edge. The error surfaces to callers as the typed `FlowCycleDetected` in the error channel.

Edge cleanup is enforced by an `AFTER DELETE` trigger on `flows_runs` rather than by call convention, so any lane that deletes a run row drops its edges in the same transaction. Writer serialization is a documented `DurableWriter.write` requirement: Postgres must run write transactions `SERIALIZABLE`.

## Reading next

[Public API tests](/api-tests) lists what is covered and what is not. [Observability](/observability) covers the surfaces you get while debugging any of the above.
