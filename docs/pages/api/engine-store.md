---
description: "The durable FlowEngine: run claims, ownership fences, attempt persistence, and cache admission."
---

# @smthrs/engine-store

The durable `FlowEngine`. It claims a run before driving it, fences every write against the current owner, and persists attempts, waits, and terminal results through [`@smthrs/journal`](/api/journal), [`@smthrs/run-store`](/api/run-store), and [`@smthrs/step-cache`](/api/step-cache). It owns the durable deferred/clock tables and composes every package's migration set.

```ts
import { EngineStore, StepBoundary } from "@smthrs/engine-store"
import * as Effect from "effect/Effect"

const engine = EngineStore.layer({
  owner: { hostId: "worker-a" },
  journalSource: "worker-a",
  isAlive: () => Effect.succeed(false)
})
```

This entry point bundles for the browser. The two host reads it once made directly, `process.pid` and `randomUUID` from `node:crypto`, enter through the [`OwnerIdentity`](#owneridentity) service.

:::warning[Bundling is not running]
The only `DurableWriter` backing shipped here is `node:sqlite`.
:::

## Entry point

| Import | Source | Platform |
| --- | --- | --- |
| `@smthrs/engine-store` | [src/index.ts](https://github.com/smithersai/smithers/blob/main/packages/engine-store/src/index.ts) | Node and browser |

## EngineStore

[src/EngineStore.ts](https://github.com/smithersai/smithers/blob/main/packages/engine-store/src/EngineStore.ts)

| Export | Kind | Notes |
| --- | --- | --- |
| `Options` | interface | `owner.hostId`, `journalSource`, `isAlive`, optional `clockFireRetryPolicy` |
| `make` | constructor | builds the engine from the required services |
| `layer` | layer | the same as a `Layer` |

Required services: `Journal`, `RunStore`, `AttemptStore`, `CacheStore`, `DurableEngineState`, kernel `Jj`, `StepBoundary`, [`OwnerIdentity`](#owneridentity), and a `Scope`. [`WorkspaceSandbox`](#workspacesandbox) and its `EffectDispatcher` are optional; when present, `make` resolves them here and re-provides them onto the engine's own fiber, which does not carry the store's layer context.

`clockFireRetryPolicy` is optional and defaults to exponential from 100ms capped at 30s, forever, which is the same option shape as the engine's `suspendedRetryPolicy`.

`isAlive` is application-supplied. Elapsed wall time alone never proves an owner is dead, so takeover consults this probe.

## DurableEngineState

[src/DurableEngineState.ts](https://github.com/smithersai/smithers/blob/main/packages/engine-store/src/DurableEngineState.ts)

| Export | Kind | Notes |
| --- | --- | --- |
| `DurableEngineState` | service tag | deferreds, clocks, waiting rows, run-parent edges |
| `Service` | interface | the methods below |
| `make`, `layer` | SQL implementation | persists through `DurableWriter` |
| `makeMemory`, `layerMemory`, `MemoryOptions`, `MemoryRunView` | memory implementation | deterministic tests |
| `DeferredAddress`, `DeferredRow`, `CompleteDeferredOutcome` | shapes | deferred completions |
| `ClockAddress`, `ClockRow`, `ScheduleClockOutcome`, `CompleteClockOutcome` | shapes | absolute deadlines |
| `Waiting`, `WaitingRow`, `WaitingRunsFilter`, `WaitingReason`, `ParkOutcome`, `WakeOutcome` | shapes | the park and wake taxonomy |
| `RunParentEdge`, `RecordRunParentOutcome`, `RunParentCycleError` | shapes + error | durable lineage and cycle rejection |
| `AttemptSurvivors` | interface | which attempt rows survive a fork or prune |

`recordRunParent` inserts the parent edge and walks the child-to-parent chain inside one write transaction, so a cycle is rejected in storage rather than by an in-process gate.

## StepBoundary

[src/StepBoundary.ts](https://github.com/smithersai/smithers/blob/main/packages/engine-store/src/StepBoundary.ts)

| Export | Kind | Notes |
| --- | --- | --- |
| `StepBoundary` | service tag | prepare and settle around an action |
| `Service`, `PreparedBoundary` | interfaces | |
| `FileBoundary`, `FileInput` | schemas + types from `@smthrs/flow/FileBoundary` | the declared filesystem boundary |
| `Action.BoundaryMode` | schema + type from `@smthrs/flow/Action` | `hard` or `expected` enforcement |
| `BoundaryEvidence`, `BoundaryDeviation`, `readSetMatches` | schemas + predicate | settle evidence |
| `referencedDigests` | accessor | the digests evidence references rather than inlines |
| `make` | constructor | from an implementation |
| `makeFileSystem`, `FileSystemOptions`, `layer` | filesystem implementation | measures declared read sets, materializes declared outputs through the [`@smthrs/artifacts`](/api/artifacts) `ArtifactStore` |
| `layerTest`, `TestOptions` | test layer | simplified descriptor for suites |
| `UndeclaredWrite`, `UnsupportedBoundary`, `BoundaryCorruption`, `MissingArtifact` | classes | boundary failures |

`layer` cannot observe writes outside the declared sets, so it never claims whole-tree write verification itself. That claim comes from running the body somewhere else; see [`WorkspaceSandbox`](#workspacesandbox). A composition without one keeps run-local results.

`MissingArtifact` is the one replay refusal a shared artifact tier can repair: the bytes are simply not on this host.

## WorkspaceSandbox

[src/WorkspaceSandbox.ts](https://github.com/smithersai/smithers/blob/main/packages/engine-store/src/WorkspaceSandbox.ts)

| Export | Kind | Notes |
| --- | --- | --- |
| `WorkspaceSandbox` | service tag | the two-phase workspace transaction |
| `Service`, `Execution` | interfaces | `execute` is speculative; `materialize` is the only host write |
| `Workspace` | service tag | the in-transaction filesystem and effect outbox, seeded only inside `execute` |
| `WorkflowResult`, `FileChange`, `QueuedEffect`, `Provenance`, `Resource`, `InputObservation`, `OutputObservation` | interfaces | the functional result of one execution |
| `Accepted`, `Invalidated`, `ExecutionResult`, `DeclarationViolation`, `CacheDisposition` | models | `Invalidated` exposes provenance and violations only |
| `Host` | interface | `snapshot`, `baseline`, `retain`, `commit`, `root`: the seam both implementations share |
| `violations` | accessor | what a declaration failed to predict |
| `make`, `layer`, `makeHosted` | constructors | from an implementation or a `Host` |
| `makeMemory`, `InitialFiles`, `MemorySandbox`, `HostFile` | in-memory implementation | deterministic, browser-safe, the conformance suite's host |
| `makeFileSystem`, `FileSystemOptions`, `layerFileSystem` | filesystem implementation | kernel `FileSystem` + `Workspace` root + [`@smthrs/artifacts`](/api/artifacts) for oversized products |
| `Dispatcher`, `EffectDispatcher`, `layerDispatcher` | optional dispatch stage | runs after copy-back settles, deduplicated by idempotency key |
| `WorkspaceError`, `WorkspaceErrorCode`, `MaterializationConflict` | classes + schema | transaction and copy-back failures |

The body observes exactly its declared read set, its writes become a diff bundle, and the host is untouched until `materialize`, a compare-and-set on every `beforeDigest` that applies whole or not at all. That is what makes whole-tree write observation structural, and therefore what lets a production-composed sealed result enter the shared cache.

Both services are optional. Without a sandbox the body runs against the host directly, exactly as before.

:::danger
This is a deterministic transaction model, not a security boundary.
:::

## ArtifactSync

[src/ArtifactSync.ts](https://github.com/smithersai/smithers/blob/main/packages/engine-store/src/ArtifactSync.ts)

| Export | Kind | Notes |
| --- | --- | --- |
| `ArtifactSync` | service tag | the two-tier artifact protocol |
| `Service` | interface | `publish(digests)`, `hydrate(digests)` |
| `makeLocal`, `layerLocal` | single-tier default | publish is a no-op, hydrate reports nothing arrived |
| `make`, `layer` | two-tier implementation | `layer` takes the local tier from the `ArtifactStore` tag |
| `ArtifactPublicationFailed` | class | a referenced artifact could not be made durable in the shared tier |

`publish` runs `findMissing` → upload the missing → re-probe to confirm immediately before the transaction that records the cache entry, never inside it. That is Bazel's REAPI ordering constraint: the action result is uploaded after every blob it refers to.

## ArtifactGc

[src/ArtifactGc.ts](https://github.com/smithersai/smithers/blob/main/packages/engine-store/src/ArtifactGc.ts)

| Export | Kind | Notes |
| --- | --- | --- |
| `ArtifactGc` | service tag | explicit artifact garbage collection |
| `Service` | interface | `gc(options)`: mark from the durable roots, sweep outside the live set and grace bound |
| `GcOptions`, `GcReport` | interfaces | `graceMs`, `pins`, `dryRun`; `sweptDigests`, `reclaimedBytes`, `keptByGrace` |
| `ArtifactGcPolicy`, `Policy`, `layerPolicy` | opt-in policy seam | default grace bound and pinned digests; configures, never schedules |
| `ArtifactGcError`, `ArtifactGcErrorCode` | class + codes | `mark_failed`, `sweep_failed` |
| `defaultGraceMs` | constant | two weeks, git's `gc.pruneExpire` default |
| `make`, `MakeOptions`, `layer` | constructor + layer | needs `SqlClient` and [`@smthrs/artifacts`](/api/artifacts) `ArtifactSweep` |

Collection never runs automatically. `gc()` is an explicit verb, and the mark is fail-safe: a root row carrying boundary evidence this build cannot decode aborts the collection rather than contributing nothing. Attempt checkpoints are also live roots, with digest-shaped strings retained conservatively. See [Artifact GC](/artifact-gc) for the algorithm and its concurrency argument.

## CacheSync

[src/CacheSync.ts](https://github.com/smithersai/smithers/blob/main/packages/engine-store/src/CacheSync.ts)

| Export | Kind | Notes |
| --- | --- | --- |
| `CacheSync` | service tag | the shared step-result publication seam |
| `Service` | interface | `publishEntry(entry)`, reporting a refusal rather than failing |
| `makeLocal`, `layerLocal` | single-tier default | nothing to publish |
| `make`, `layer` | shared implementation | over a remote [`CacheStore`](/api/step-cache) |

The entry is published after the transaction that made the local row durable, because a host call must never be held across a `DurableWriter` write. Pair it with `CombinedCacheStore` in `"deferred"` publication mode, which leaves the shared write to this seam.

Neither publication step can fail a run. By the time they run the result is already durably recorded on this host, so a refusal withholds the shared copy and journals a `cache-provenance` record with `action: "unpublished"`, which is visible rather than silent.

## Inconsistency

[src/Inconsistency.ts](https://github.com/smithersai/smithers/blob/main/packages/engine-store/src/Inconsistency.ts)

| Export | Kind | Notes |
| --- | --- | --- |
| `Inconsistency` | service tag | receives cache conflicts and blob corruption |
| `Service`, `MakeOptions`, `CacheConflict`, `BlobCorruption` | shapes | |
| `InconsistencyVerdict` | type | what the receiver decides |
| `make`, `makeNoop` | constructors | |
| `layerStrict` | layer | journal the conflict, then fail the run |
| `layerTolerant` | layer | journal the conflict and continue |
| `layerNoop` | layer | |

The unwired core default is strict.

## OwnerIdentity

[src/OwnerIdentity.ts](https://github.com/smithersai/smithers/blob/main/packages/engine-store/src/OwnerIdentity.ts)

| Export | Kind | Notes |
| --- | --- | --- |
| `OwnerIdentity` | service tag | `@smthrs/engine-store/OwnerIdentity` |
| `Service` | interface | `ownerId(hostId)` mints the `OwnerId` this incarnation fences with |
| `make` | constructor | from an implementation |
| `makeDefault`, `layer` | default implementation | the platform's process id where one exists, a `Random`-drawn incarnation number where none does, paired with a `crypto.randomUUID` nonce |
| `layerConstant` | layer | pins a whole `OwnerId`, for a test or a host that derives ownership from a lease it already holds |

Minting an owner id is nondeterminism against the host, so it sits behind a port rather than in the composition. That is what makes this package browser-bundleable: the module carries no Node binding, reading `process?.pid` off `globalThis` instead.

## RunState

[src/RunState.ts](https://github.com/smithersai/smithers/blob/main/packages/engine-store/src/RunState.ts)

| Export | Kind | Notes |
| --- | --- | --- |
| `RunState` | schema + type | the versioned state envelope the engine stores in each run row |

## Errors

[src/Errors.ts](https://github.com/smithersai/smithers/blob/main/packages/engine-store/src/Errors.ts)

| Export | `code` |
| --- | --- |
| `FlowCycleDetected` | `flow_cycle_detected` |
| `AttemptAdmissionRejected` | `attempt_admission_rejected` |
| `CacheConflictDetected` | `cache_conflict_detected` |
| `CacheCorruptionDetected` | `cache_corruption_detected` |
| `AttemptEvidenceQuarantined` | `attempt_evidence_quarantined` |

Every `code` literal is part of the public API. Consumers may switch on `code` or `_tag`.

## Migrations

[src/Migrations.ts](https://github.com/smithersai/smithers/blob/main/packages/engine-store/src/Migrations.ts)

| Export | Kind | Notes |
| --- | --- | --- |
| `set` | `MigrationSet` | the namespaced set for `flows_deferred_completions` and `flows_clock_deadlines`, in id block `3000` |
| `sets` | `ReadonlyArray<MigrationSet>` | journal, run-store, step-cache, this package, then [`@smthrs/plan`](/api/plan): the whole durable engine schema, in dependency order |
| `run` | effect | apply every set |
| `layer` | layer | applies every set at construction |

## Internal scheduling

`internal/RunCoordinator` deduplicates in-process work by key and exposes `active`, `run`, `wake`, and `interrupt` around scoped fibers. It is in-memory scheduling, not persistence, and is not exported: distributed ownership is `@smthrs/run-store`'s `RunStore`.

## Test layers

| Export | Source | Notes |
| --- | --- | --- |
| `TestStores.layer(options?)`, `TestStores.database` | [src/test/TestStores.ts](https://github.com/smithersai/smithers/blob/main/packages/engine-store/src/test/TestStores.ts) | migrated journal, run, attempt, and cache services over ONE in-memory SQLite database |
