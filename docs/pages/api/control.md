---
description: "@smthrs/control: the control services, their RPC group, the server and client, and the SQL control runtime."
---

# `@smthrs/control`

This page is the public API reference for the control plane: the
transport-independent `Control` service, the `ControlRuntime` port it writes
through, the projections it reads back, and the durable adapter that binds both
to a real database.

`Control` is authority, not execution. Every mutation it accepts is idempotent,
principal-stamped, and recorded in the journal beside the state change it
caused, so "who asked for this, and when did it take effect?" is answered from
persisted evidence rather than from a log line.

## Service

`Control` exports `plan`, `run`, `approve`, `deny`, `steer`, `signal`,
`cancel`, `pause`, `resume`, `list`, and `watch`. `ControlLive.layer`
implements the service over `ControlRuntime`, `Journal`, `NotificationQueue`,
and `Registry`. `SqlControlRuntime.layer` is the durable runtime;
`ControlRuntime.layerMemory` is the deterministic in-memory one, and both are
held to the shared contract in `packages/control/test/ControlContract.ts`.

## Run lineage

A run's ancestry is recorded by whoever created it. `RunSummary` reports all of
it under one vocabulary:

| Field | Source | Meaning |
| --- | --- | --- |
| `parentRunId` | `flows_runs.parent_run_id`, else the `flows_run_parents` spawn edge | The run this one branched from: its spawner, the run it was forked off, or the previous trampoline round. |
| `lineageId` | `flows_runs.lineage_id` | The trampoline lineage this run is a round of. |
| `roundOrdinal` | `flows_runs.round_ordinal` | Which round. Absent means a lineage of one, read as round 0 of itself. |
| `origin` | derived | `child`, `fork`, or `continuation`. |

The engine records the two relationships in two places, so the projection reads
both. `parent_run_id` is the trampoline chain: the round before this one. A run
that another run SPAWNED writes nothing in its own row: the edge lives in the
`flows_run_parents` DAG that cycle detection walks, so a projection that read
the column alone would report every child of every run as an orphan. The column
wins when a row has both, which is the case for round 1 of a run that was
itself spawned: its nearest ancestor is the round before it.

`Lineage.originOf` is the derivation, and it is pure: a run with a
`fork-created` marker on its journal is a `fork`, a run past round 0 is a
`continuation`, any other run with a parent is a `child`, and a run with no
parent has no origin. A rewind is deliberately absent from the vocabulary. It
truncates a run in place and creates none, so it is a thing that happened to a
run, not a reason a run exists.

`list` selects on the same fields:

```ts
const children = yield* control.list({
  _tag: "runs",
  filters: { parentRunId: "run-17" }
})

const rounds = yield* control.list({
  _tag: "runs",
  filters: { lineageId: "run-17" }
})
```

The durable listing covers every row in `flows_runs`, not only the runs the
control plane launched itself. A child, a fork, and a later trampoline round
are all created by the engine straight into the run store, and a control plane
that listed only its own launches could not answer what a run spawned. Runs the
plane launched keep launch order; the rest follow in creation order. A run
whose `state_json` is not a control summary, an engine-created run, is
projected from the run row's own columns instead, with the engine's `flowName`
as its `flowId`.

A listing reads the fork markers, the spawn edges, the waiting reasons, and the
cancellation evidence of every row, because it projects every row. Reading ONE
run, which is what every mutation does before it writes, reads the run and
its ancestor chain and nothing else, so the cost of steering or cancelling a
run does not grow with the size of the database. Cascade attribution needs the
ancestors and stops there; the chain is one recursive read over `parent_run_id`
plus one spawn-edge read per nesting level.

## Watch and lineage deltas

`watch` streams committed journal entries as `ControlEvent` values, and expands
three of them into an extra `control.run.lineage` delta:

| Entry | Producer | Delta |
| --- | --- | --- |
| `flows.engine.run-decision` with `decision: "created"` at round 0 or with no round | `@smthrs/engine-store` | `{ runId, parentRunId, origin: "child" }` |
| `flows.engine.run-decision` with `decision: "handed-off"` | `@smthrs/engine-store` | `{ runId, parentRunId, lineageId, roundOrdinal, origin: "continuation" }` |
| `flows.time-travel.fork-created` | `@smthrs/time-travel` | `{ runId, parentRunId, origin: "fork" }` |

The handoff is what carries a trampoline, and a continuation round's own
`created` decision is skipped. The engine journals both in one transaction: it
creates the next round with `{decision: "created", lineageId, roundOrdinal,
parentExecutionId}` and records `{decision: "handed-off", nextExecutionId}` on
the round that finished. Both name the same pair, so deriving from both would
report one run as a `child` of its predecessor on one entry and a
`continuation` of it on the other. The handoff is the one kept, because it
reaches a consumer watching the run that hands off, which is the run an
operator is already following when a trampoline advances. Exactly one delta
therefore names each continuation round, whichever round of the lineage the
consumer is watching.

The delta carries the sequence of the entry it was derived from, so a consumer
resuming at a cursor sees it exactly once. Expansion runs after the follow
stream's deduplication, so a derived event never competes with its own entry
for a `(runId, sequence)` key. A `created` decision that names no parent
discloses no ancestry and derives nothing.

`Lineage.derive` and `Lineage.expand` are the projection, exported so a client
that reads the journal directly reaches the same conclusions the server does.

## Live steering

`steer` writes one durable item into the notification queue and journals the
enqueue beside it. `SteerMessage` is a union, because an operator steers a run
for four different reasons and only one of them is something to tell the model:

| Variant | Payload | What the next turn does |
| --- | --- | --- |
| `Message` (the default, and what a `body` alone decodes as) | `body` | Inserts the body into the transcript. |
| `Seat` | `seat` | Runs the turn on that model seat. |
| `Thinking` | `thinking` | Runs the turn at that thinking level. |
| `Tools` | `toolNames` | Adds those tools to the active set. |

`ControlSchema.steerItem` strips the control envelope: who asked, when, for
which run, and returns the `@smthrs/notifications` `SteerPayload` the harness
reads back. `Notifications.make` in `@smthrs/harness` maps each payload onto
the matching `Steering.Item`, so a seat steer changes the seat instead of
spending a turn announcing it.

A steer has two durable moments and two writers:

| Event | Writer | Payload |
| --- | --- | --- |
| `control.steer.enqueued` | `Control.steer` | `{ runId, messageId, kind }` |
| `control.steer.delivered` | derived by `Steering.derive` from the queue's `flows/notifications/Promoted` entry | `{ runId, messageId, boundary }` |

Delivery is derived rather than recorded, because the boundary that delivered
the steer runs in the agent process and not in the control plane. A control
plane that wrote its own delivery record would be asserting a fact it did not
observe. One promotion entry names a batch, so it derives one delta per message
id, each carrying the sequence of the entry it came from; a consumer resuming
at a cursor sees the batch exactly once.

`RunSummary.steering.pending` counts what has been admitted and not yet
promoted, read from the queue rather than from a column, because the queue owns
both halves. A queue that cannot answer leaves the field absent.

### Waking a parked run

A steer to a parked run resumes it when the park is one a message can end:

| `waitingReason` | Steered |
| --- | --- |
| `event` | Resumed. The run is waiting for something to arrive, and a steer is something arriving. |
| `released` | Resumed. A sweep took the run away from a dead owner, and nothing is coming to claim it. |
| `approval`, `timer`, `quota` | Left parked. The run is waiting for a decision, a clock, or a budget that a message does not supply. |
| absent | Left parked. A park with no reason is an operator's `pause`, and a message queued behind it is queued for when the operator resumes. |

`RunSummary.waitingReason` is the run row's `waiting_reason`, which the engine
writes when it parks a run and clears on the wake. The control plane reads it
and never writes it, so `Control.pause` leaves the column empty and an empty
column is how an operator pause is told apart from an engine park. A reason
this table does not name is left parked too: a control plane that cannot
explain a park should not end it.

A steer to a run that already reached `cancelled`, `completed`, or `failed`
returns a `Terminal` receipt and stores nothing. Storing it anyway would leave
an operator watching a message with no boundary left to deliver it.

## Cancellation attribution

A durable cancellation is anonymous on its own: `flows_runs.cancel_requested_at_ms`
records that somebody asked and when, and nothing else. `RunSummary.cancellation`
is the attribution the journal adds back.

| Field | Meaning |
| --- | --- |
| `requestedAt` | When the cancellation was asked for. |
| `source` | `control`, `cascade`, or `engine`. |
| `principal` | Who asked. Present on a `control` source and on the `cascade` it started. |
| `reason` | Why, as the operator stated it. |
| `cascadedFrom` | The cancelled ancestor this run was swept up with. |

`cancel` takes the reason and the principal:

```ts
yield* control.cancel({
  runId: "run-17",
  reason: "budget",
  idempotencyKey: "cancel:run-17"
})
```

The reason and the principal are written onto the `control.run.cancel-requested`
entry inside the mutation's own transaction, so a cancellation cannot commit
anonymously.

The `Cancel` RPC carries the reason and refuses a caller-named principal: the
server stamps the identity it authenticated, so a remote operator states why
and never states who. The principal's `stampedAt` is a record of when that
authentication happened: evidence about an external event, never a value any
decision is replayed from.

`Cancellation.attribute` is the fold, and it is pure and scope-independent: it
reads whatever evidence it is handed and never issues a query. A listing folds
the whole database; reading one run folds that run and its ancestor chain,
which is the smallest scope that can still answer the question. Cascade is a
fact about a run's ancestors, so it cannot be decided one row at a time: the
request that cancelled a child may be several rounds up the chain. Three
sources rank in the order a run's own evidence outranks its ancestors':

1. A `control.run.cancel-requested` entry names the run. It says who and why.
2. A cancelled ancestor exists. The run reports `cascade`, names the ancestor,
   and inherits that ancestor's principal and reason, because the honest answer
   to "who cancelled this child" is the operator who cancelled its parent.
3. Neither. The engine cancelled the run on its own account, and there is no
   principal to report.

Evidence that a run was cancelled at all is any of: the run store's
`cancel_requested_at_ms`, the engine's `flows.engine.interrupted` record with
outcome `cancelled`, or an attributed request naming the run. The last one
matters because a control plane cancelling a run it owns interrupts the fiber
rather than writing the request column, and its journal entry is the whole
record.

## Monitor

`Monitor` answers the question after "what is this run doing": is that all
right, and if not, what now. `classify` is pure, so the vocabulary an operator
reads on a dashboard is the one a heal loop branches on:

| Condition | Health | Because |
| --- | --- | --- |
| No summary | `unknown` | Nothing to say, and nothing to do. |
| `failed` | `failing` | The run itself reported the failure. |
| `completed`, `cancelled` | `healthy` | A finished run needs nothing. |
| `waiting-approval`, or parked on `approval` | `awaiting-human` | A human owes it an answer. |
| `roundOrdinal` at or past `roundBound` | `runaway-loop` | The lineage loops without converging. |
| The last settled attempt failed | `failing` | The run is alive and its work is not landing. |
| No progress for `stallBeats`, an attempt open | `wedged-node` | One attempt started and never settled. |
| No progress for `stallBeats` | `stalled` | Nothing is happening and nothing is in flight. |
| Anything else | `healthy` | Entries are still arriving. |

`awaiting-human` outranks `failing` on purpose. A run parked for approval after
a failed attempt is waiting for a person, and resuming or cancelling it would
take the decision away from them.

Progress is measured from `flows.engine.attempt-started` and
`flows.engine.attempt-finished`, which the engine journals as a pair: an excess
of starts is an attempt still in flight. The classification reads durable
evidence only, never an in-process fiber, which is what lets a monitor watch a
run in another process.

`Monitor.run` beats over `Control`:

```ts
const report = yield* Monitor.run({
  runId: "run-17",
  monitorId: "oncall-supervisor",
  intervalMs: 5_000,
  maxChecks: 60,
  stallBeats: 3,
  autoHeal: ["stalled", "wedged-node"]
})
```

Each beat lists the run, replays its journal, classifies, and records
`control.monitor.beat`, carrying the `remedy` it is about to attempt, before
applying any remedy, so a monitor that crashes mid-heal leaves the evidence of
what it decided. The remedy is a second record, `control.monitor.healed`,
written only once the heal returned a receipt: a heal that failed must not
leave a durable record saying the run was healed. Both are excluded from the
progress measurement, because a monitor that counted its own bookkeeping as
progress could never observe a stall.

`monitorId` defaults to `default` and names the writer: it is the source of
every record the monitor writes (`/control/monitor/<monitorId>`) and the
`monitorId` field in each payload. Nothing on the control plane leases a run to
one watcher, so two monitors on one run both beat and both remedy. The
identity is what makes their evidence tellable apart and their default remedies
distinct: the built-in `resume` and `cancel` keys are
`monitor:<monitorId>:<remedy>:<runId>:<beat>`. A remedy must be idempotent on
the control plane; a custom `heal` owes the same property.

`remedyFor` maps a health onto an action: `stalled` and `wedged-node` resume,
`failing` and `runaway-loop` cancel, everything else does nothing, and
`autoHeal` decides which of them the monitor may actually apply. It is empty by
default, because a monitor that healed by default would cancel a run the first
time it looked at one. A remedy resets the stall count, so one stall produces
one resume rather than one per beat. The loop stops early on a terminal run.

See [Time travel](/concepts/time-travel),
[Subflows](/concepts/subflows), and the
[control-plane trust posture](/guides/control-plane-trust).
