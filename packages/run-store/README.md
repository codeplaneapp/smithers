# @smthrs/run-store

Durable run state, fenced ownership, and executable attempt state for Smithers
flows.

`RunStore` and `AttemptStore` are the authority a restarted engine reads. The
journal remains history, audit, and replay evidence. Because both packages use
the same `@smthrs/database` `DurableWriter`, `Journal.transact` can commit a
state projection and its durable events atomically.

```sh
pnpm add @smthrs/run-store
```

## Public surface

| Namespace         | Responsibility                                                                                                                                                              |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RunStore`        | Run lifecycle, cancellation, exact-snapshot claims, ownership fences, recovery, and terminal transitions. Its public limits bound executable state depth, nodes, and bytes. |
| `AttemptStore`    | Fenced step attempts, checkpoints, heartbeats, outcomes, and patches. Its public limits bound checkpoint and JSON values.                                                   |
| `Ownership`       | `OwnerId`, liveness evidence, fail-closed PID probing, lease checks, and heartbeat supervision.                                                                             |
| `RunStoreMetrics` | Attributed counters for claim, heartbeat, and transition outcomes.                                                                                                          |
| `Migrations`      | The `flows_runs` and `flows_attempts` migration set and layer.                                                                                                              |

The root and matching namespace subpaths are driver-neutral and
browser-bundleable. Two subpaths are not namespaces of the root barrel:

| Import                                | Platform | Public exports                                                                                                                                                                                                                                |
| ------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@smthrs/run-store/Heartbeat`         | any      | The lease constants `heartbeatInterval`, `heartbeatStaleAfter`, `heartbeatSkewAllowance`, and `heartbeatWriteTolerance`, also re-exported from `Ownership`. A consumer that needs only the durations imports this leaf and pulls in no store. |
| `@smthrs/run-store/test/TestRunStore` | Node     | `layer`, providing migrated in-memory `RunStore` and `AttemptStore` services.                                                                                                                                                                 |

```ts
import { AttemptStore, Migrations, RunStore } from "@smthrs/run-store"
import * as Heartbeat from "@smthrs/run-store/Heartbeat"
import * as TestRunStore from "@smthrs/run-store/test/TestRunStore"
```

Migration implementations and package internals are blocked from exports.

## Ownership clock

The injected Effect `Clock` is the sole lease authority. It timestamps claims,
activation, recovery, heartbeats, steals, and terminal transitions. Public
`nowMs` arguments are validated observation tokens used to bind liveness
evidence to a call; they cannot expire or extend a lease. The binding is exact
equality: `claimAndOwn`, `recoverClaim`, and `steal` accept evidence only when
`evidence.checkedAtMs` equals the `nowMs` of the same call, so a probe taken at
one instant cannot be replayed into another. `steal` reports
`LivenessUnconfirmed` when evidence does not match and reserves
`SnapshotChanged` for a matching-evidence comparison that loses to a changed
row. `requestCancel` keeps its timestamp as request metadata because it grants
no ownership.

Every owned write compares the complete `(hostId, processId, nonce)` fence in
the same SQL statement as its mutation. `sameHostPidProbe` treats only `ESRCH`
as proof of death; invalid pids and every other probe failure fail closed.

## Durable values

Run state, checkpoint, error, outcome, and metadata inputs are copied as inert
JSON before persistence can yield. Accessors, `toJSON`, cycles, malformed text,
excess depth, excess nodes, and oversized encodings are rejected through typed
errors without retaining the value in diagnostics. Stored rows are validated
again on read.

The bounds are public constants, not private thresholds. Run state is bounded
by `RunStore.maximumRunStateBytes`, `maximumRunJsonDepth`, and
`maximumRunJsonNodes`; attempt values by `AttemptStore.maximumValueBytes`,
`maximumJsonDepth`, and `maximumJsonNodes`. Only the checkpoint ceiling is
configurable, through `AttemptStore.Options.maxCheckpointBytes`, and it may not
exceed `AttemptStore.maximumCheckpointBytes`. Nothing is redacted: these rows
are executable resume data, so rewriting a field whose name resembles a
credential would corrupt the run rather than protect it.

See the generated [run-store reference](https://smithers.sh/api/run-store),
[concurrency model](https://smithers.sh/concepts/concurrency), and
[journal model](https://smithers.sh/concepts/journal).
