`RunStore` and `AttemptStore` are the executable authority a restart reads.
The journal is history, audit, and replay evidence; these rows say what is
running and which process may mutate it. Both stores write through
[`@smthrs/database`](/api/database), so a surrounding `Journal.transact`
commits a projection and its durable events in one serialized transaction.

```ts
import { AttemptStore, Migrations, RunStore } from "@smthrs/run-store"
import * as Layer from "effect/Layer"

const layer = Layer.mergeAll(RunStore.layer, AttemptStore.layer).pipe(
  Layer.provideMerge(Migrations.layer)
)
```

## Entry points

| Import                                | Source                                                                                                                   | Platform |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | -------- |
| `@smthrs/run-store`                   | [src/index.ts](https://github.com/smithersai/smithers/blob/main/packages/run-store/src/index.ts)                         | any      |
| `@smthrs/run-store/Heartbeat`         | [src/Heartbeat.ts](https://github.com/smithersai/smithers/blob/main/packages/run-store/src/Heartbeat.ts)                 | any      |
| `@smthrs/run-store/test/TestRunStore` | [src/test/TestRunStore.ts](https://github.com/smithersai/smithers/blob/main/packages/run-store/src/test/TestRunStore.ts) | Node     |

The root is driver-neutral and browser-bundleable. Migration implementations
and internal admission helpers are deliberately blocked from package exports.
`Heartbeat` is the lease-constant leaf. `Ownership` re-exports all four
durations, so the subpath exists for a consumer that wants the numbers without
the stores, and `packages/flows` uses it that way in its containment test.

## Ownership and clocks

Every ownership mutation is fenced by the complete `OwnerId`: host, process
id, and nonce. Claiming is two phase (`claim` then `activate`) or atomic
(`claimAndOwn`). Heartbeats, attempt writes, and owned transitions compare all
three fields in the same SQL statement as their mutation.

The injected Effect `Clock` is the sole lease authority. It stamps claims,
activation, heartbeats, recovery, steals, and terminal transitions, and it
sets every staleness cutoff. Public `nowMs` arguments remain validated
observation tokens so `LivenessEvidence.checkedAtMs` cannot be replayed across
calls, but they cannot expire a live lease or pin one into the future.
`requestCancel` is different: its timestamp is request metadata and does not
grant ownership.

`sameHostPidProbe` treats only `ESRCH` as proof of death. Permission errors,
unexpected failures, invalid pids, and synthetic pid zero fail closed. A pid
is inspected only when observer and owner name the same host; cross-host
recovery relies on the persisted lease.

## Run state

`create` inserts a pending row. `RunSnapshot` is the exact status, owner, and
heartbeat tuple used by claim compare-and-swap operations. Partial ownership
snapshots are invalid: running requires both owner and heartbeat, while every
other status requires neither. Terminal rows cannot be reopened.

`transitionOwned` changes status and optional executable state under one owner
fence. Its optional cancellation guard is compiled into that same update, so
a request cannot arrive between a check and a terminal write. `requestCancel`
is idempotent, never writes a terminal row, and distinguishes absence from a
run that settled during the transaction.

Run identifiers and lineage fields are bounded, non-empty, well-formed durable
text. State is inert JSON copied without invoking getters or `toJSON`, bounded
by `maximumRunStateBytes`, `maximumRunJsonDepth`, and
`maximumRunJsonNodes`, and checked again on read. Lifecycle timestamps must be
non-negative safe integers and ordered consistently with the row status.
Diagnostics retain field names and sizes, never executable state.

## Attempts

`AttemptStore` addresses a row by `(runId, stepKeyDigest, attempt)` and fences
`put`, `heartbeat`, `finish`, and `patch` against the owning running run.
Default `put` is first-writer-wins; `putMode: "upsert"` may update an in-flight
row but never reopen a terminal attempt. `inProgressStates` and checkpoint
limits are validated, detached, and frozen when the store is built.

Checkpoint, error, outcome, and metadata values cross the same inert bounded
JSON admission. Inputs are snapped before persistence can yield. Attempt and
heartbeat timestamps never move backward, and a finish before start is
rejected. The values are not redacted: they are executable resume data, so
rewriting a field because its name resembles a credential would corrupt the
run. Secrets belong at host-owned outbound I/O boundaries instead.

## Outcomes and failures

Compare-and-swap competition is represented by tagged success values such as
`FenceLost`, `SnapshotChanged`, `HeartbeatFresh`, `AlreadyClaimed`, and
`EvidenceRequired`. Invalid input, corrupt durable rows, and persistence
failures use the typed `RunStoreError` or `AttemptStoreError` channel. This
separation lets callers retry contention without treating corruption as a
race.

`RunStoreMetrics` provides attributed views for every claim, activation,
recovery, heartbeat, and transition outcome. A fence loss is therefore visible
without parsing logs.

## Migrations and testing

`Migrations.set` owns `flows_runs` and `flows_attempts` in migration block
1000. `Migrations.layer` installs this package alone;
[`@smthrs/engine-store`](/api/engine-store) composes the complete storage
ladder. `@smthrs/run-store/test/TestRunStore` supplies migrated in-memory
SQLite services for adapter tests. Cross-process fencing tests use a real
SQLite file.

See [concurrency](/concepts/concurrency), the
[durable execution model](/concepts/durable-execution-model), and the
[`@smthrs/journal` reference](/api/journal).
