# @smthrs/run-store

Durable run state for flows: what is running now, and who owns it. Split out
of `@smthrs/journal` — see
[`docs/specs/Concepts/Journal Split.md`](../../../docs/specs/Concepts/Journal%20Split.md).

`RunStore` and `AttemptStore` hold the **executable authoritative state** that
recovery reads. They are not derived from the journal's event history: the
journal is history, audit, replay evidence, and the sync feed, and this package
is the thing a restart rebuilds from. `Journal.transact` is what keeps the two
halves consistent — it runs a state projection here and the `emitDurable` calls
describing it in ONE write transaction, because both write through the same
`DurableWriter` and so join it as savepoints.

`Ownership` supplies the liveness evidence, probes, and heartbeat supervision
that arbitrate a run's owner. `RunStore` only _validates_ supplied evidence; it
never probes a process or a network itself.

```sh
pnpm add @smthrs/run-store
```

## Public API

The root exports these namespaces, also available from matching
`@smthrs/run-store/*` subpaths.

| Namespace      | Public exports                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RunStore`     | `RunStatus`, `RunStoreErrorCode`, `RunStoreError`, `RunSnapshot`, `RunRow`, `CreateOptions`, and `TransitionGuard`; outcome types `RequestCancelOutcome`, `ClaimOutcome`, `ClaimAndOwnOutcome`, `ActivateOutcome`, `AbandonClaimOutcome`, `RecoverClaimOutcome`, `HeartbeatOutcome`, and `TransitionOutcome`; `Service` / `RunStore` for create/get/cancel, claim/activate/recover/steal, heartbeat, and owned transitions; `make`, `makeNoop`, `layerNoop`, and SQL `layer`. |
| `Ownership`    | `OwnerId` (re-exported from `@smthrs/journal`, which defines it as the fence on durable appends), `LivenessEvidence`, `LivenessProbe`, `heartbeatInterval`, `heartbeatStaleAfter`, `heartbeatSkewAllowance`, `heartbeatWriteTolerance`, and `heartbeatLoop`.                                                                                                                                                                                                                  |
| `AttemptStore` | `AttemptStoreErrorCode`, `AttemptStoreError`, `AttemptId`, `Attempt`, `FinishAttempt`, `AttemptPatch`, `Options`, and result types `PutResult`, `PatchResult`, `HeartbeatResult`, `FinishResult`; `Service` / `AttemptStore` operations `put`, `get`, `heartbeat`, `finish`, and `patch`; `makeWith`, `make`, `makeNoop`, `layerNoop`, `layer`, and `layerWith`.                                                                                                              |
| `Migrations`   | `set` (the namespaced migration set for `flows_runs` and `flows_attempts`), `run`, and prerequisite `layer`.                                                                                                                                                                                                                                                                                                                                                                  |

The root is written against the driver-neutral `@smthrs/database` contract and
bundles for the browser. The test double binds a Node SQLite database, so it
lives under an explicit subpath:

| Import                                | Public exports                                                                      |
| ------------------------------------- | ----------------------------------------------------------------------------------- |
| `@smthrs/run-store/test/TestRunStore` | **Node only.** `layer`, providing migrated in-memory `RunStore` and `AttemptStore`. |

An engine needs this package, `@smthrs/journal`, and `@smthrs/step-cache` over
one database; `@smthrs/engine-store/Migrations` composes all four migration
sets, and `@smthrs/engine-store/test/TestStores` is the in-memory bundle.

```ts
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import { Migrations, RunStore } from "@smthrs/run-store"
import { Effect, Layer } from "effect"

const database = NodeDatabase.layer({ filename: "flows.db" })
const runs = RunStore.layer.pipe(
  Layer.provide(Layer.provideMerge(Migrations.layer, database))
)

const program = Effect.gen(function*() {
  const store = yield* RunStore.RunStore
  yield* store.create("run-1", "{}")
}).pipe(Effect.provide(runs))
```

See the [run ownership concept](../../../docs/specs/Concepts/Run%20Ownership.md).
