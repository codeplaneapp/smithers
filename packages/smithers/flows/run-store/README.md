# @smthrs/run-store

**Documentation:** https://run-store.smithers.sh

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

| Namespace         | Responsibility                                                                                                                                                           |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `RunStore`        | Run lifecycle, cancellation, exact-snapshot claims, ownership fences, recovery, and terminal transitions. Its public limits bound executable state depth and node count. |
| `AttemptStore`    | Fenced step attempts, checkpoints, heartbeats, outcomes, and patches. Its public limits bound JSON shape, plus the one configurable checkpoint byte ceiling.             |
| `Ownership`       | `OwnerId`, liveness evidence, fail-closed PID probing, lease checks, and heartbeat supervision.                                                                          |
| `RunStoreMetrics` | Attributed counters for claim, heartbeat, and transition outcomes.                                                                                                       |
| `Migrations`      | The `flows_runs` and `flows_attempts` migration set and layer.                                                                                                           |

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

## Ownership clocks

Two clock sources stamp a run row, and the split is deliberate. The operations
that accept or verify `LivenessEvidence` (`claim`, `claimAndOwn`, `steal`,
`heartbeat`, `requestCancel`, and `recoverClaim`) take the caller's `nowMs` and
judge it literally: it is the lease cutoff they compare against and the value
they persist. Lifecycle stamps come from the injected Effect `Clock`: `create`
writes `created_at_ms`, `activate` writes `started_at_ms` and
`heartbeat_at_ms`, and `transitionOwned` writes `finished_at_ms`. One row can
therefore carry readings from two clocks, so a composition must give both
sources the same reading.

Every `nowMs` is validated as a non-negative safe integer. The lease operations
(`claim`, `claimAndOwn`, `steal`, `heartbeat`, and `recoverClaim`) then bound
it from above: a reading that runs ahead of the store's `Clock` by more than
`heartbeatSkewAllowance` fails with `invalid_run` before any predicate runs,
because no composition produces one honestly and it is the one lever that
steals a fresh owner or pins a lease past the cutoff. A reading behind the
clock is admitted: it makes every staleness judgment more conservative, and
the monotonic heartbeat absorbs it. `requestCancel` keeps the literal reading,
since its timestamp is request data rather than a lease predicate, and the
`claimedAtMs` fence tokens of `activate`, `abandonClaim`, and `recoverClaim`
are compared against the row rather than bounded. Inside the allowance a
reading is trusted completely: the store cannot tell a slow clock from a lie.
That is the right contract for an in-process library over a local SQLite file
whose caller can issue raw SQL itself, and it must not cross a trust boundary.
The evidence binding is exact equality: `claimAndOwn`, `recoverClaim`, and
`steal` accept evidence only when `evidence.checkedAtMs` equals the `nowMs` of
the same call, so a probe taken at one instant cannot be replayed into another.
`steal` reports `LivenessUnconfirmed` when evidence does not match and reserves
`SnapshotChanged` for a matching-evidence comparison that loses to a changed
row. A heartbeat is monotonic: a pulse delayed past a newer one still reports
`Updated` but never moves `heartbeat_at_ms` backwards.

Every owned write compares the complete `(hostId, processId, nonce)` fence in
the same SQL statement as its mutation. `sameHostPidProbe` treats only `ESRCH`
as proof of death; invalid pids and every other probe failure fail closed.

## Durable values

Run state, checkpoint, error, outcome, and metadata inputs are copied as inert
JSON before persistence can yield. Accessors, `toJSON`, cycles, malformed text,
excess depth, and excess node counts are rejected through typed errors without
retaining the value in diagnostics. Stored rows are validated again on read.

The boundary bounds shape, not size. Run state, metadata, errors, and outcomes
have no byte ceiling by design: these rows are executable resume data, and a
multi-megabyte state a flow legitimately produced has to persist or the run
cannot continue. The shape bounds are public constants:
`RunStore.maximumRunJsonDepth` and `maximumRunJsonNodes` for run state,
`AttemptStore.maximumJsonDepth` and `maximumJsonNodes` for attempt values. The
one byte ceiling is the checkpoint policy, configured through
`AttemptStore.Options.maxCheckpointBytes` and capped by
`AttemptStore.maximumCheckpointBytes`.

Timestamps are range-checked independently, never against each other: the
store does not adjudicate the caller's timeline, so an attempt whose
`finishedAtMs` precedes its `startedAtMs` persists as written. Nothing is
redacted, because rewriting a field whose name resembles a credential would
corrupt the run rather than protect it.

See the generated [run-store reference](https://smithers.sh/docs/reference/api/run-store),
[concurrency model](https://smithers.sh/docs/concepts/ownership), and
[journal model](https://smithers.sh/docs/concepts/durable-execution).
