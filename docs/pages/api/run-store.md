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
| `@smthrs/run-store` | [src/index.ts](https://github.com/smithersai/smithers/blob/main/packages/run-store/src/index.ts) | any |
| `@smthrs/run-store/test/TestRunStore` | [src/test/TestRunStore.ts](https://github.com/smithersai/smithers/blob/main/packages/run-store/src/test/TestRunStore.ts) | Node |

## RunStore

[src/RunStore.ts](https://github.com/smithersai/smithers/blob/main/packages/run-store/src/RunStore.ts)

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

[src/RunStoreMetrics.ts](https://github.com/smithersai/smithers/blob/main/packages/run-store/src/RunStoreMetrics.ts)

| Export | Kind | Notes |
| --- | --- | --- |
| `claims` | counter | `flows_run_claims`, dimensioned by `op` and `outcome` |
| `heartbeats` | counter | `flows_run_heartbeats`, dimensioned by `outcome`; `fence_lost` is the fencing event |
| `transitions` | counter | `flows_run_transitions`, dimensioned by `outcome` and target status `to` |
| `claim`, `claimAndOwn`, `activate`, `steal`, `heartbeat`, `transition` | attributed views | keyed by each operation's outcome `_tag`; `RunStore` updates them as compare-and-swaps resolve |

## Ownership

[src/Ownership.ts](https://github.com/smithersai/smithers/blob/main/packages/run-store/src/Ownership.ts)

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

[src/AttemptStore.ts](https://github.com/smithersai/smithers/blob/main/packages/run-store/src/AttemptStore.ts)

| Export | Kind | Notes |
| --- | --- | --- |
| `AttemptStore` | service tag | address is `(runId, stepKeyDigest, attempt)` |
| `AttemptId`, `Attempt`, `FinishAttempt`, `AttemptPatch`, `Options` | interfaces | row and argument shapes |
| `PutResult`, `PatchResult`, `HeartbeatResult`, `FinishResult` | types | fenced outcomes |
| `AttemptStoreError`, `AttemptStoreErrorCode` | class + codes | |
| `make`, `makeWith`, `makeNoop` | constructors | `makeWith` takes an in-progress vocabulary and checkpoint cap |
| `layer`, `layerWith`, `layerNoop` | layers | |

## Migrations

[src/Migrations.ts](https://github.com/smithersai/smithers/blob/main/packages/run-store/src/Migrations.ts)

| Export | Kind | Notes |
| --- | --- | --- |
| `set` | `MigrationSet` | the namespaced set for `flows_runs` and `flows_attempts`, in id block `1000` |
| `run` | effect | apply the run and attempt schema |
| `layer` | layer | applies it at construction |

## Test layers

| Export | Source | Notes |
| --- | --- | --- |
| `TestRunStore.layer` | [src/test/TestRunStore.ts](https://github.com/smithersai/smithers/blob/main/packages/run-store/src/test/TestRunStore.ts) | migrated run and attempt stores over in-memory SQLite |

## API reference

This page is the public API reference for **executable run state**: run rows,
action attempt rows, and the ownership arbitration that fences them. It was
split out of `@smthrs/journal`: see
`docs/specs/Concepts/Journal Split.md`.

Recovery reads these stores. The journal is history, audit, replay evidence,
and the sync feed; this package is what a restart rebuilds from.
`Journal.transact` keeps the two halves consistent, because both write through
the same `DurableWriter` and so commit as one transaction.

### RunStore

`RunStore` exports:

- `RunStatus`: `pending`, `running`, `suspended`, `completed`, `failed`, or `cancelled`.
- `RunRow`, `RunSnapshot`, `CreateOptions`, and `TransitionGuard`.
- fenced `create`, `get`, `claim`, `claimAndOwn`, `activate`, `abandonClaim`, `recoverClaim`, `heartbeat`, `transitionOwned`, and `steal`, plus unfenced `requestCancel`.
- tagged outcome unions for every compare-and-set operation.
- `make`, `layer`, `makeNoop`, and `layerNoop`.

#### Run metadata: columns versus `state_json`

`flows_runs` carries exactly two metadata columns beyond identity, lifecycle, and ownership:

| Column | Why it is a column |
| --- | --- |
| `cancel_requested_at_ms` | It participates in a compare-and-swap. `transitionOwned(..., { cancelRequested: "absent" })` compiles the predicate into the same `UPDATE` as the ownership fence, so a cancellation request cannot slip between a read and a terminal write. |
| `parent_run_id` | Lineage is walked in SQL. A recursive CTE over `parent_run_id` answers ancestry questions that a JSON side-channel would force into decode-then-filter. |

Everything else a harness records about a run, flow name and hash, cancel attribution, pause and hijack requests, VCS coordinates, config, stays in `state_json`. That is the intended extension point, not a workaround: those fields are read with the row, never guarded on, and adding a column per harness concept would make the schema a union of its consumers. `state_json` is checked to be valid JSON, and `transitionOwned` replaces it atomically with the status change.

When a `state_json` field does need to be scanned, index the expression rather than promoting the column:

```sql
CREATE INDEX flows_runs_flow_name_idx
ON flows_runs (json_extract(state_json, '$.flowName'));

SELECT run_id FROM flows_runs
WHERE json_extract(state_json, '$.flowName') = 'deploy';
```

Promote a field to a column only when it must appear in a CAS guard. `TransitionGuard` is the seam for that: new guarded metadata extends the interface and the single `UPDATE`, rather than adding a transition variant per rule.

`requestCancel(runId, nowMs)` records the request without an owner fence: any observer may ask, and the owner decides at its next guarded transition. It returns `CancelRequested`, `AlreadyRequested` (with the original request time, which is never overwritten), `Terminal` (the run had already settled, carrying the status it settled with), or `NotFound`. The status predicate is part of the compare-and-swap, so a run that settles under a caller loses the write rather than racing it: a settled run has no owner and no drive to observe a request, and a reader that took the column as live intent would cancel children the run had finished with. `NotFound` means the row is gone and nothing else: a run that settles inside the retry window reports `Terminal`, not absence. A guarded transition that loses only to its guard returns `GuardFailed`, distinct from `FenceLost`.

`Ownership.OwnerId` contains `hostId`, `pid`, and `nonce`. `LivenessEvidence` records observer and observation time. `heartbeatLoop`, `heartbeatInterval`, `heartbeatStaleAfter`, `heartbeatSkewAllowance`, and `heartbeatWriteTolerance` support scoped ownership maintenance. The loop interrupts its owner immediately on durable evidence that the fence is gone (any outcome other than `Updated`), but tolerates failed heartbeat *writes* for `heartbeatWriteTolerance`. That budget is `heartbeatStaleAfter` minus `heartbeatSkewAllowance` minus one heartbeat tick. The allowance is explicit because the owner stamps the heartbeat from its own clock while the stealer judges it against *its* clock, so the hosts' offset is subtracted straight from the owner's margin; the tick covers the budget only being re-evaluated once per pulse. Within the allowance the owner always stops executing side effects before a steal can be admitted. Beyond it the lease is bounded, not guaranteed: durable writes stay safe because the ownership compare-and-set fences them, but non-durable external side effects can overlap: inherent to any wall-clock lease, and a caller that cannot tolerate overlap needs a fencing token at the side effect itself. A successful pulse re-arms that window.

`LivenessEvidence.kind` is one of three. `same-host-pid-dead` is a local process probe and is accepted only from an observer on the owner's host, because a pid means nothing outside its own process namespace. `cross-host-unreachable-stale` is a reachability judgement and is accepted only from another host. `lease-expired` asserts only that the persisted heartbeat is older than `heartbeatStaleAfter`, so it is accepted from any observer: `steal` verifies that claim itself in the same write and refuses a row whose lease is still inside the window.

`LivenessCheck` is the question an engine asks before it steals: `(expectedOwner, { claimant, heartbeatAtMs, nowMs }) => Effect<boolean>`, where `true` refuses the takeover. `leaseLiveness(staleAfter)` is the default answer: the owner is alive while the lease is fresh, gone once it expires, and gone when it recorded no heartbeat at all. It is the weakest honest answer and the one every host can give, so a composition that supplies nothing still reclaims a hard-killed owner's runs. `sameHostIncarnation(expectedOwner, claimant)` is the predicate a stronger check applies before it reads `expectedOwner.pid`. `sameHostPidProbe` is that stronger check for Node hosts: it answers from `process.kill(pid, 0)` when the recorded owner and the claimant share a host, reads `EPERM` as a live process it may not signal, and answers `false` for any owner on another host, where a pid means nothing and the expired lease decides instead. A composition passes it; nothing defaults to it. `EngineStore.Options.isAlive` left unset is `leaseLiveness(heartbeatStaleAfter)` on every host, the Node CLI hands `sameHostPidProbe` to `EngineStore.layer` explicitly because two `smithers` invocations in one project directory are two engine processes over one `.flows/engine.db`, and a browser composition keeps `leaseLiveness`. `@smthrs/platform-node`'s `HostLiveness.isAlive` asks the same question of the same process table but answers `true` for an owner on another host, which refuses that steal outright and leaves a dead host's runs unreclaimable. Two limits are inherent to asking a pid, and both probes share them. An owner recorded with the claimant's own pid, a previous incarnation of this process or a second engine composed inside it, differs from the claimant only by `nonce` and names this very process, so it is always alive and its row is never stolen while the process lives; an embedded host that re-creates its engine in place keeps `leaseLiveness`, whose timeout does expire. Reading same-pid-different-nonce as death is not the alternative: two engines in one process are the shape the probe exists to arbitrate. A pid the operating system has reused reports the unrelated process that now holds it, which delays a dead owner's reclaim rather than breaking it: the row is still `running` under an expired lease, and the next probe after the pid is free reclaims it.

### AttemptStore

`AttemptStore` addresses rows with `AttemptId`, exposes `put`, `get`, `heartbeat`, `finish`, and `patch`, and returns explicit fenced outcome unions.

`make`/`layer` use the default policy; `makeWith(options)`/`layerWith(options)` take an `Options`:

| Option | Default | Effect |
| --- | --- | --- |
| `inProgressStates` | `["running"]` | States the store treats as still in progress. `heartbeat` and `finish` fence on membership, and `finish` refuses them as targets. A harness whose vocabulary is `in-progress` configures it here instead of translating at the boundary. |
| `maxCheckpointBytes` | `1048576` | Largest encoded checkpoint accepted. Raise it when the durable mid-attempt checkpoint is an agent session rather than a cursor. |
| `putMode` | `"insert"` | `"insert"` is first-writer-wins: a re-put with different content reports `Conflict`. `"upsert"` overwrites the row and reports `Upserted`. Both keep the run-ownership fence. |

`finish` COALESCEs `error_json`, `outcome_json`, and `meta_json`: a value recorded mid-flight by `put` or `patch` survives a terminal claim that omits it, and supplying one replaces it. Only `put`'s upsert rewrites those columns unconditionally, because an upsert restates the whole row.

`patch(id, fields)` is the unfenced surface for opaque fields, checkpoint, error, outcome, and metadata, and never moves `state`, `started_at_ms`, or `finished_at_ms`. Omitted fields are left as recorded. It returns `Patched` or `NotFound`. Fields such as response text, worktree pointers, or cache flags belong in `meta`; the fenced lifecycle stays with `put`/`heartbeat`/`finish`.

`AttemptStore` exports SQL `make`/`layer` plus no-op test seams.

### Redaction stops at the journal

Journal payloads are redacted on write; the stores that hold *executable*
state are deliberately not. `RunStore.state_json` is decoded and re-entered on
every resume, an `AttemptStore` checkpoint is handed back to the retrying step,
and an outcome is returned verbatim as the replayed result. A name-suffix
redactor there is silent corruption, not defence: a legitimate `pageToken`
resumes as `"[REDACTED]"` and the flow reads the wrong page, and a non-string
field like `clientSecret: { … }` becomes a string, so schema decode of the
persisted state dies and the run is undrivable (issue #72). These stores
therefore take no `redact` option at all: `RunStore.layer` and
`AttemptStore.layer` round-trip their columns byte-for-byte. See the
[`@smthrs/journal` reference](/api/journal) for the write-side rules.

### Entry points

The root holds the stores and their contracts, all written against the
driver-neutral `@smthrs/database` service, and it bundles for the browser
(`pnpm run browser`). The test double binds a Node SQLite database and is
therefore imported from `@smthrs/run-store/test/TestRunStore`. A consumer that
needs the journal, the run store, and the step cache over ONE database takes
`@smthrs/engine-store/test/TestStores`. See
[browser support](/architecture/browser-support).

### Migrations

`Migrations.set` is this package's namespaced migration set: `flows_runs`,
its three indexes, and `flows_attempts`, and reserves migration id block
`1000`. `Migrations.run` / `Migrations.layer` install it alone;
`@smthrs/engine-store/Migrations` composes it with the journal's, the step
cache's, and the engine's. See
[`@smthrs/database`](/api/database) for the composition rules.

See `docs/specs/Concepts/Run Ownership.md`, the
[`@smthrs/journal` reference](/api/journal), and the
[`@smthrs/engine-store` reference](/api/engine-store).
