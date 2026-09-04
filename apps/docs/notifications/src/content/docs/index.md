---
title: "@smthrs/notifications"
description: "The durable notification queue: admit a message to a run exactly once, drain it at a turn boundary, and page about a run that has been stuck too long."
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/notifications/docs/README.md"
---

`@smthrs/notifications` carries a message to a run that is already running.

A run in flight is not listening. The operator who steers it, the parent run
that signals it, and the supervisor that pages about it all write from a
different process, at a moment when interrupting the run would change what the
model is looking at while it is looking at it. This package holds what they
said until the run reaches a point where it can read it, and it holds it in the
journal, so a host that dies between the writing and the reading loses nothing.

The service has three methods:

- `admit` records one notification against a run, exactly once, and answers with
  what the queue decided.
- `drain` promotes what one boundary of one lineage may deliver, and answers
  with the notifications the durable record commits to.
- `pending` reports what a run has been told that no boundary has delivered yet.

`Alerts` points the same machinery at the run itself. A policy reads a run's
journal, and a condition that has stayed open longer than its rule allows
becomes a coalesced system event on this queue and a page to a sink.

## Who uses this package

A control plane admits: [`@smthrs/control`](https://control.smithers.sh/reference/api/) turns an operator's
steer into a `human-steer` notification. A harness drains:
[`@smthrs/harness`](https://harness.smithers.sh/reference/api/) reads the queue at each turn boundary and
turns what it gets into inserts and seat changes. A supervisor alerts: the
`Alerts` runtime reads the journal a monitor writes and pages about what has
been wrong too long. All three depend on this package, and none of them depends
on the others, which is why the vocabulary they share lives here.

## Install

```bash
pnpm add @smthrs/notifications
```

The queue needs a `Journal.Journal` from [`@smthrs/journal`](https://journal.smithers.sh/reference/api/) to be
durable. For the layer stack a real composition builds, see
[Installation](/installation/).

## The smallest real example

Admitting a steer is one call, and the receipt says what happened to it:

```ts
import { NotificationQueue } from "@smthrs/notifications"
import * as Effect from "effect/Effect"

const steer = Effect.gen(function*() {
  const queue = yield* NotificationQueue.NotificationQueue
  const receipt = yield* queue.admit("run-1", {
    _tag: "human-steer",
    id: "message-1",
    delivery: "steer",
    targetLineageId: "run-1",
    provenance: {
      sourceRunId: "operator",
      sourceLineageId: "operator",
      sourceTurn: 0,
      sourceActor: "human:will"
    },
    payload: { kind: "Message", body: "look at the failing test first" }
  })
  return receipt.decision
})
```

`receipt.decision` is `admitted`, `coalesced`, or `rejected-full`, and reading
it is not optional: a full queue retains nothing and journals nothing, so a
caller that treats the receipt as an acknowledgement loses the message in
silence. See [Handle a full queue](/guides/handle-a-full-queue/).

For a run that admits, drains, and prints what the boundary delivered, see the
[Quickstart](/quickstart/).

## The package at a glance

The root entry point exports these namespaces, and each is also importable from
`@smthrs/notifications/<Module>`:

| Namespace           | What it is                                                                                              |
| ------------------- | ------------------------------------------------------------------------------------------------------- |
| `NotificationQueue` | The durable service: `admit`, `drain`, `pending`, and the journal-backed layer behind them.             |
| `Notification`      | The three notification shapes, their delivery classes, and the provenance every one carries.            |
| `NotificationState` | The pure bounded queue: admission, coalescing, and promotion, with no I/O.                              |
| `NotificationEvent` | The two journal records the queue writes, and the decoder that reads them back out of a shared journal. |
| `Projection`        | A journal projection that re-derives pending notifications from those records.                          |
| `SteerPayload`      | The steering vocabulary a control plane writes and a harness reads.                                     |
| `Alerts`            | Run conditions that outlive a delay, turned into coalesced, delivered-once notifications.               |

Every export of every namespace, with its signature and what each parameter
means, is on the [API reference](/reference/api/).

## Where to go next

- [Installation](/installation/): requirements, the journal a composition
  adds, and the import forms.
- [Quickstart](/quickstart/): admit two notifications and drain them at a
  turn boundary, over an in-memory journal.
- Concepts: [admission and promotion](/concepts/admission-and-promotion/),
  [the journal records](/concepts/journal-records/), and
  [how alerting decides](/concepts/alerting/).
- Guides: [steer a run](/guides/steer-a-run/),
  [drain at a turn boundary](/guides/drain-at-a-turn-boundary/),
  [handle a full queue](/guides/handle-a-full-queue/),
  [report what a run is waiting on](/guides/report-pending-notifications/),
  [alert on a stuck run](/guides/alert-on-a-stuck-run/),
  [send alerts to a webhook](/guides/send-alerts-to-a-webhook/), and
  [test against the queue](/guides/testing/).
- [Troubleshooting](/troubleshooting/): the failures this package reports,
  what causes each one, and what to change.
