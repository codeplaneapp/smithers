---
title: "Run the scheduler in a host"
description: "Compose the durable store, the Control-backed runner, and the scheduler layer; choose the two poll intervals; and understand what happens to running flows when the host shuts down."
sidebar:
  order: 2
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/agent/triggers/docs/guides/run-the-scheduler.md"
---

The scheduler is a poll loop. Every tick it lists the enabled triggers, works
out what each one owes, claims what is due, and launches through a `Runner`.
This guide composes it into a host.

## Compose the layers

Three layers stack, bottom to top: a database, a store over it, and a runner
beside it.

```ts
import * as DurableWriter from "@smthrs/database/DurableWriter"
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import * as Scheduler from "@smthrs/triggers/Scheduler"
import * as SqlTriggerStore from "@smthrs/triggers/SqlTriggerStore"
import * as Layer from "effect/Layer"

const database = Layer.provideMerge(
  DurableWriter.layer(),
  NodeDatabase.layer({ filename: "smithers.db" })
)

/** Requires Control.Control, and provides a running Scheduler. */
export const triggers = Scheduler.layer({ pollInterval: "30 seconds" }).pipe(
  Layer.provide(Scheduler.layerControlRunner),
  Layer.provide(SqlTriggerStore.layer),
  Layer.provide(database)
)
```

`SqlTriggerStore.layer` applies the package's migrations when it builds, so
there is nothing to run beforehand. `Scheduler.layerControlRunner` is the
production launcher: it requires `Control.Control` from
[`@smthrs/control`](https://control.smithers.sh/reference/api/) and reaches nothing else.

`Scheduler.layer` forks a supervisor fiber into the layer's scope. It sleeps
only through the Effect `Clock`, so scope closure interrupts it. It also
recovers from the whole cause of a failed tick, not just the typed error: a
defect raised anywhere under a tick would otherwise kill the fiber and stop
every trigger in the process with nothing written down.

## Choose the two intervals

```ts
Scheduler.layer({ pollInterval: "30 seconds", runPollInterval: "5 seconds" })
```

| Option            | Default      | What it paces                                                                  |
| ----------------- | ------------ | ------------------------------------------------------------------------------ |
| `pollInterval`    | `"1 minute"` | How often a tick lists triggers and evaluates due work.                        |
| `runPollInterval` | `"1 second"` | How often a launched run's monitor asks the runner whether it is still active. |

Both must be finite, positive Effect durations. Zero polls a CPU-tight loop and
an infinite interval never completes, and `Duration.fromInput` accepts both, so
the scheduler refuses them itself with `invalid_options` and
`TriggerError.path` naming the field.

Set `pollInterval` below the tightest schedule you run. A one-minute cron under
a five-minute poll still fires, because catch-up replays the boundaries the poll
skipped, but only if the declaration asked for catch-up.

## Tick without a supervisor

`Scheduler.make` returns the same service without forking anything, so the
caller decides when a tick happens. Use it in tests, in a one-shot process, or
under a scheduler you already own:

```ts
import * as Scheduler from "@smthrs/triggers/Scheduler"
import * as Effect from "effect/Effect"

const oneTick = Effect.scoped(Effect.gen(function*() {
  const scheduler = yield* Scheduler.make()
  yield* scheduler.runOnce
}))
```

`runOnce` holds a semaphore permit, so two concurrent calls on one scheduler
serialize rather than interleave.

`Scheduler.makeNoop` and `Scheduler.layerNoop` provide an inert scheduler
without allocating a supervisor fiber, for a composition that needs the service
in scope but no scheduling.

## What a parked plan does

`layerControlRunner` calls `control.plan`, then runs the returned plan. When
Control answers `Parked`, the plan is waiting for a human approval. The runner
re-offers the same idempotent request with a delay that doubles from one
second, up to `Scheduler.parkedAttempts`, which is 8. The eighth attempt lands a
little over two minutes in, and the launch then fails with `runner`.

The runner never approves the plan and never reconstructs an execution
envelope. A schedule that keeps parking is a schedule whose flow needs an
approval nobody is giving.

## Shutdown does not cancel runs

Closing the scheduler's scope interrupts the poll loop and detaches every run
monitor. It stops there on purpose: the runs themselves are durable and outlive
the process, so a deploy must leave them alone. The next incarnation re-attaches
to them by reading the store.

Cancellation is a deliberate act, and the only thing that performs it is a
`supersede` claim replacing a run in flight.

## Failure isolation

A tick walks the due triggers in id order. One trigger's failure is logged with
its id annotated and does not stop the triggers after it, and a failed
occurrence stays available to a later poll rather than being marked handled.
Interruption is the exception: it is the scope closing, not a trigger failing,
so it propagates.

## Next

- [The claim protocol](/concepts/claim-protocol/): what happens when two
  hosts run this same loop.
- [Troubleshooting](/troubleshooting/): the failures a tick reports.
