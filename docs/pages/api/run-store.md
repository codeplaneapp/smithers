---
description: "Executable run state: run rows, attempt rows, and the ownership arbitration that fences them."
---

# @smthrs/run-store

Executable run state: run rows, action attempt rows, and the ownership arbitration that fences them. Split out of [`@smthrs/journal`](/api/journal). Both stores write through the `@smthrs/database` contract, so the package root bundles for the browser.

```ts
import { AttemptStore, Migrations, RunStore } from "@smthrs/run-store"
import * as Layer from "effect/Layer"

const layer = Layer.mergeAll(RunStore.layer, AttemptStore.layer).pipe(
  Layer.provideMerge(Migrations.layer)
)
```

## Entry points

| Import | Source | Platform |
| --- | --- | --- |
| `@smthrs/run-store` | [src/index.ts](https://github.com/smithersai/flows/blob/main/packages/run-store/src/index.ts) | any |
| `@smthrs/run-store/test/TestRunStore` | [src/test/TestRunStore.ts](https://github.com/smithersai/flows/blob/main/packages/run-store/src/test/TestRunStore.ts) | Node |

## RunStore

[src/RunStore.ts](https://github.com/smithersai/flows/blob/main/packages/run-store/src/RunStore.ts)

| Export | Kind | Notes |
| --- | --- | --- |
| `RunStore` | service tag | `@smthrs/run-store/RunStore` |
| `RunStatus` | const + type | `pending`, `running`, `suspended`, `completed`, `failed`, `cancelled` |
| `RunRow`, `RunSnapshot`, `CreateOptions`, `TransitionGuard` | interfaces | row and argument shapes |
| `RunStoreError`, `RunStoreErrorCode` | class + codes | |
| `ClaimOutcome`, `ClaimAndOwnOutcome`, `ActivateOutcome`, `AbandonClaimOutcome`, `RecoverClaimOutcome`, `HeartbeatOutcome`, `TransitionOutcome`, `RequestCancelOutcome` | types | compare-and-swap results |
| `make`, `makeNoop` | constructors | |
| `layer`, `layerNoop` | layers | |

| Method | Behavior |
| --- | --- |
| `create(runId, stateJson, options?)` | inserts a `pending` row |
| `get(runId)` | reads the exact row |
| `requestCancel(runId, nowMs)` | records an unfenced cancellation request |
| `claim(runId, expected, claimant, nowMs)` | compare-and-swap on an exact snapshot |
| `claimAndOwn(runId, expected, owner, nowMs, evidence?)` | claim plus activate in one step |
| `activate(runId, claimant, claimedAtMs, expected)` | promotes a claim to ownership |
| `abandonClaim`, `recoverClaim` | generation-fenced claim release and stale-claim recovery |
| `heartbeat(runId, owner, nowMs)` | refreshes the owner fence |
| `transitionOwned(runId, owner, toStatus, stateJson?, guard?)` | owned status change |
| `steal(runId, expected, claimant, nowMs, evidence)` | takeover with liveness evidence |

## RunStoreMetrics

[src/RunStoreMetrics.ts](https://github.com/smithersai/flows/blob/main/packages/run-store/src/RunStoreMetrics.ts)

| Export | Kind | Notes |
| --- | --- | --- |
| `claims` | counter | `flows_run_claims`, dimensioned by `op` and `outcome` |
| `heartbeats` | counter | `flows_run_heartbeats`, dimensioned by `outcome`; `fence_lost` is the fencing event |
| `transitions` | counter | `flows_run_transitions`, dimensioned by `outcome` and target status `to` |
| `claim`, `claimAndOwn`, `activate`, `steal`, `heartbeat`, `transition` | attributed views | keyed by each operation's outcome `_tag`; `RunStore` updates them as compare-and-swaps resolve |

## Ownership

[src/Ownership.ts](https://github.com/smithersai/flows/blob/main/packages/run-store/src/Ownership.ts)

| Export | Kind | Value |
| --- | --- | --- |
| `OwnerId` | schema + type | `hostId`, `pid`, `nonce` |
| `LivenessEvidence` | schema + type | application-supplied proof an owner is gone |
| `LivenessProbe` | type | probe signature |
| `heartbeatInterval` | `Duration` | 1 second |
| `heartbeatWriteTolerance` | `Duration` | 19 seconds |
| `heartbeatStaleAfter` | `Duration` | 30 seconds |
| `heartbeatSkewAllowance` | `Duration` | clock-skew slack |
| `heartbeatLoop` | function | the owner heartbeat fiber |

## AttemptStore

[src/AttemptStore.ts](https://github.com/smithersai/flows/blob/main/packages/run-store/src/AttemptStore.ts)

| Export | Kind | Notes |
| --- | --- | --- |
| `AttemptStore` | service tag | address is `(runId, stepKeyDigest, attempt)` |
| `AttemptId`, `Attempt`, `FinishAttempt`, `AttemptPatch`, `Options` | interfaces | row and argument shapes |
| `PutResult`, `PatchResult`, `HeartbeatResult`, `FinishResult` | types | fenced outcomes |
| `AttemptStoreError`, `AttemptStoreErrorCode` | class + codes | |
| `make`, `makeWith`, `makeNoop` | constructors | `makeWith` takes an in-progress vocabulary and checkpoint cap |
| `layer`, `layerWith`, `layerNoop` | layers | |

## Migrations

[src/Migrations.ts](https://github.com/smithersai/flows/blob/main/packages/run-store/src/Migrations.ts)

| Export | Kind | Notes |
| --- | --- | --- |
| `set` | `MigrationSet` | the namespaced set for `flows_runs` and `flows_attempts`, in id block `1000` |
| `run` | effect | apply the run and attempt schema |
| `layer` | layer | applies it at construction |

## Test layers

| Export | Source | Notes |
| --- | --- | --- |
| `TestRunStore.layer` | [src/test/TestRunStore.ts](https://github.com/smithersai/flows/blob/main/packages/run-store/src/test/TestRunStore.ts) | migrated run and attempt stores over in-memory SQLite |
