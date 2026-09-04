---
title: "@smthrs/run-store"
description: "Durable run state, fenced ownership, and step attempts for Smithers flows: the rows a restarted engine reads to decide what is running and which process may mutate it."
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/run-store/docs/README.md"
---

`@smthrs/run-store` holds the executable authority for a durable run: what is
running, how far it got, and which process is allowed to move it.

Two services own that authority. `RunStore` holds one row per run: its status,
its owner, its heartbeat, and the executable state a resume re-enters.
`AttemptStore` holds one row per step attempt: its state, its checkpoint, and
what it finished with. `Ownership` supplies the arbitration around them, and
`RunStoreMetrics` counts every outcome they decide.

The journal in [`@smthrs/journal`](https://journal.smithers.sh/reference/api/) is the other half of durability
and answers a different question. The journal is history, audit, and replay
evidence: what happened, in order. These rows are the current fact a restarted
process reads before it does anything. Both write through the same
[`@smthrs/database`](https://database.smithers.sh/reference/api/) `DurableWriter`, so a surrounding
`Journal.transact` commits a state projection and its durable events in one
serialized transaction.

## Who uses this package

Engine and control-plane authors use it directly: [`@smthrs/engine-store`](https://engine-store.smithers.sh/reference/api/)
composes it into the durable engine's storage ladder, and
[`@smthrs/control`](https://control.smithers.sh/reference/api/) drives it from the control plane. A flow author
never calls it, because the engine does. Reach for it when you are writing the
host that owns runs, sweeping stalled runs, or building an adapter that has to
agree with the engine about who owns what.

## Install

```bash
pnpm add @smthrs/run-store
```

For the driver, the migration set, and the import forms, see
[Installation](/installation/).

## Claiming a run

Ownership is a compare-and-swap against the exact row you read, never a lock:

```ts
import { RunStore } from "@smthrs/run-store"
import * as Clock from "effect/Clock"
import * as Effect from "effect/Effect"

const owner = { hostId: "host-a", pid: 4102, nonce: "3f9c" }

const takeOver = Effect.gen(function*() {
  const runs = yield* RunStore.RunStore
  const row = yield* runs.get("run-1")
  const expected = { status: row.status, owner: row.owner, heartbeatAtMs: row.heartbeatAtMs }
  const nowMs = yield* Clock.currentTimeMillis

  const claim = yield* runs.claim("run-1", expected, owner, nowMs)
  if (claim._tag !== "Claimed") return claim
  return yield* runs.activate("run-1", owner, claim.claimedAtMs, expected)
})
```

`expected` is the row you read, restated. If any of those three fields moved
while you were deciding, the write refuses and tells you which race you lost.
Competition is a success value, never a failure: `AlreadyClaimed`,
`HeartbeatFresh`, and `SnapshotChanged` are ordinary outcomes, while
`RunStoreError` is reserved for invalid input, corrupt rows, and database
failures. See [Fencing and ownership](/concepts/fencing/).

## The package at a glance

The root entry point exports these namespaces, and each is also importable from
`@smthrs/run-store/<Module>`:

| Namespace         | What it is                                                                                                                                  |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `RunStore`        | The run row: lifecycle, cancellation intent, ownership compare-and-swaps, fenced transitions, and the shape limits on executable run state. |
| `AttemptStore`    | The attempt row: fenced starts, checkpoints, heartbeats, terminal outcomes, and patches, under a configurable policy.                       |
| `Ownership`       | `OwnerId`, liveness evidence, the pid probe and the lease check, the heartbeat constants, and the supervision loop.                         |
| `RunStoreMetrics` | Attributed counters for every claim, heartbeat, and transition outcome the stores decide.                                                   |
| `Migrations`      | The `flows_runs` and `flows_attempts` schema, as a migration set and as a layer.                                                            |

Every export of every namespace, with signatures and outcomes, is on the
[API reference](/reference/api/).

## Where to go next

- [Installation](/installation/): the driver, the peer packages, the import
  forms, and what is blocked from the export map.
- [Quickstart](/quickstart/): create a run, claim it, record an attempt, and
  finish it, against an in-memory database.
- Concepts: [fencing and ownership](/concepts/fencing/),
  [the heartbeat lease](/concepts/leases/),
  [liveness evidence](/concepts/liveness-evidence/), and
  [durable values](/concepts/durable-values/).
- Guides: [compose the stores](/guides/compose-the-stores/),
  [claim a run and finish it](/guides/claim-and-finish-a-run/),
  [record a step attempt](/guides/record-step-attempts/),
  [cancel a run](/guides/cancel-a-run/),
  [take over a stalled run](/guides/recover-a-stalled-run/),
  [observe store outcomes](/guides/observe-outcomes/), and
  [testing](/guides/testing/).
- [Troubleshooting](/troubleshooting/): every typed failure and refused
  outcome, what causes it, and what to change.
