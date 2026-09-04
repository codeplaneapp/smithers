---
title: "Test against the queue"
description: "Run the real queue over an in-memory journal, use the explicit noop seams, drive alert delays on the test clock, and test the promotion rules as pure functions."
sidebar:
  order: 7
---

Nothing in this package needs stubbing to be deterministic. The journal is a
service, the clock is a service, the sink is a service, and the promotion rules
are pure functions. Swap the services; keep the code under test.

## Run the real queue in memory

`TestJournal.layer()` from [`@smthrs/journal`](/api/journal) is the production
SQLite journal over an in-memory database, with migrations already run. Compose
it under `NotificationQueue.layer` and every durable guarantee is real:

```ts
import { Journal } from "@smthrs/journal"
import * as TestJournal from "@smthrs/journal/test/TestJournal"
import { NotificationQueue } from "@smthrs/notifications"
import * as Effect from "effect/Effect"

const run = <A, E>(
  effect: Effect.Effect<A, E, NotificationQueue.NotificationQueue | Journal.Journal>
): Promise<A> =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(NotificationQueue.layer),
      Effect.provide(TestJournal.layer()),
      Effect.scoped
    )
  )
```

Use `NotificationQueue.layerWith({ capacity })` to reach the capacity bound
without admitting 128 notifications first.

## Prove durability with a file, not a layer

One in-memory journal and one queue cannot separate "the journal records this"
from "the layer remembered it". To test a claim about what survives a process,
build the stack over a real file, close it, and build a second stack over the
same rows:

```ts
import * as DurableWriter from "@smthrs/database/DurableWriter"
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import * as Migrations from "@smthrs/journal/Migrations"
import * as SqlJournal from "@smthrs/journal/SqlJournal"
import { NotificationQueue } from "@smthrs/notifications"
import * as Layer from "effect/Layer"

const over = (filename: string, capacity: number) =>
  NotificationQueue.layerWith({ capacity }).pipe(
    Layer.provideMerge(
      SqlJournal.layer({ capacity: 1024, overflow: "reject" }).pipe(
        Layer.provide(
          Layer.provideMerge(
            Migrations.layer,
            Layer.provideMerge(DurableWriter.layer(), NodeDatabase.layer({ filename }))
          )
        )
      )
    )
  )
```

`test/NotificationQueueRestart.test.ts` and `test/AlertsRestart.test.ts` use
exactly this shape: the drain identity, the pending fold, and a capacity refusal
are all properties of what was written, not of a live process.

## The explicit absences

Every service in this package ships a stated absence, so a test provides the
smallest composition that type-checks:

| Service             | Explicit absence                      | What it does                                        |
| ------------------- | ------------------------------------- | --------------------------------------------------- |
| `NotificationQueue` | `NotificationQueue.layerNoop()`       | Fails every method with `notification_unavailable`. |
| `NotificationQueue` | `NotificationQueue.makeNoop({ ... })` | The same, with named methods replaced.              |
| `Alerts.Sink`       | `Alerts.layerNoop`                    | Accepts every alert and sends nothing.              |

`layerNoop` takes the same overrides, so a test can serve one method and leave
the rest failing:

```ts
import { NotificationQueue } from "@smthrs/notifications"
import * as Effect from "effect/Effect"

const onlyPending = NotificationQueue.layerNoop({
  pending: () => Effect.succeed([])
})
```

A composition that means to serve nothing says so in writing. That is what makes
"the queue is unavailable" a case a caller can test, rather than a case it
discovers in production. See
[Report what a run is waiting on](./report-pending-notifications.md).

## Drive an alert delay on the test clock

An alert's decision is a comparison against journal time, so a test moves the
clock instead of waiting:

```ts
import * as TestJournal from "@smthrs/journal/test/TestJournal"
import { Alerts, NotificationQueue } from "@smthrs/notifications"
import * as Layer from "effect/Layer"
import { TestClock } from "effect/testing"

const stack = (policy: Alerts.Policy, sink: Layer.Layer<Alerts.Sink>) =>
  Alerts.layer(policy).pipe(
    Layer.provideMerge(Layer.mergeAll(NotificationQueue.layer, sink)),
    Layer.provideMerge(TestJournal.layer()),
    Layer.provideMerge(TestClock.layer())
  )
```

`TestClock.adjust("59 seconds")` then `tick` raises nothing for a rule with a
60 second delay; one more second and it pages. Move the clock between a refusal
and its retry too, because in production it always moves: an alert whose content
varied with the reading time would be refused by the queue as a reused id and
never page at all.

## Test the rules as pure functions

`NotificationState` has no I/O, so the promotion rules need no layers:

```ts
import { NotificationState } from "@smthrs/notifications"
import type { Notification } from "@smthrs/notifications/Notification"

export const promotedAtCutoff = (notifications: ReadonlyArray<Notification>, cutoff: number) => {
  let state = NotificationState.empty(8)
  notifications.forEach((notification, index) => {
    state = NotificationState.admit(state, notification, index).state
  })
  return NotificationState.promoteSteers(state, cutoff).promoted.map((item) => item.notification.id)
}
```

`Alerts.conditions` and `Alerts.decide` are pure in the same way, and take the
journal entries and the instant as arguments. Assert on them directly before
reaching for a runtime.

## Assert on the durable evidence

The records are the evidence, and reading them is how a test proves a claim
about behavior rather than about a return value:

- `flows/notifications/Admitted`, one per retained notification.
- `flows/notifications/Promoted`, one per drained boundary.
- `Alerts.deliveredEventType`, one per delivered alert.
- `Alerts.failedEventType`, one per alert per failure code.

Counting them is what distinguishes "the alert was suppressed" from "the alert
was never raised", and "the webhook is down" from "the webhook is down and we
appended a row per tick for an hour".
