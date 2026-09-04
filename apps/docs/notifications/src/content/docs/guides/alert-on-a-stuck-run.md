---
title: "Alert on a stuck run"
description: "Write an alert policy, add a detector for a condition your deployment journals itself, tick the runtime, and read the four outcomes it reports."
sidebar:
  order: 5
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/notifications/docs/guides/alert-on-a-stuck-run.md"
---

An alert policy watches a run's journal for a condition that has stayed open too
long, admits it to the notification queue, and pages a sink.

## Write the policy

A policy is delays plus ownership. `rules` names the conditions to watch and how
long each one may last:

```ts
import { Alerts } from "@smthrs/notifications"

export const policy: Alerts.Policy = {
  defaults: { severity: "warning", owner: "oncall" },
  rules: {
    "waiting-approval": { afterMs: 900_000, runbook: "https://runbook.example/approvals" },
    stalled: { afterMs: 300_000, severity: "critical" }
  }
}
```

`defaults` fills in what a rule leaves out, so the delay is stated per condition
and the ownership once. `afterMs` must be a whole, non-negative number of
milliseconds; `Alerts.layer` decodes the policy when it builds, so an impossible
delay fails the composition rather than mis-paging later.

`waiting-approval` and `stalled` are two of the four conditions
`Alerts.defaultDetectors` recognizes out of the box, alongside `failed` and
`quota-parked`. A rule for a condition with no detector raises nothing.

## Add a detector for your own condition

A condition is a payload field with a value. To alert on something your own
supervisor journals, name the field, the value, and the entries worth reading:

```ts
import { Alerts } from "@smthrs/notifications"

export const wedged: Alerts.Policy = {
  defaults: { severity: "warning", owner: "oncall" },
  rules: { "wedged-node": { afterMs: 900_000, runbook: "https://runbook.example/wedged-runs" } },
  detectors: {
    "wedged-node": {
      field: "health",
      value: "wedged-node",
      eventTypes: ["control.monitor.beat"]
    }
  }
}
```

`eventTypes` matters more than it looks. Without it, every entry carrying a
`health` field is evidence, including the monitor's own heal record, which names
the same health and would re-open the condition the next beat closed. Narrow to
the entries that actually report the condition.

Your `detectors` are merged over `Alerts.defaultDetectors`, so naming one of the
four built-in conditions replaces its detector and leaves the rest alone.

## Compose the runtime

`Alerts.layer(policy)` needs the journal, the notification queue, and a sink:

```ts
import { Alerts, NotificationQueue } from "@smthrs/notifications"
import * as Layer from "effect/Layer"

export const alerting = Alerts.layer(policy).pipe(
  Layer.provideMerge(Layer.mergeAll(NotificationQueue.layer, Alerts.layerNoop))
)
```

`Alerts.layerNoop` accepts every alert and sends it nowhere. The admission and
the delivery record still happen, so a deployment with no outbound channel keeps
the durable evidence of what it would have paged about, and keeps the detection
path exercised rather than switched off. For a real pager, see
[Send alerts to a webhook](/guides/send-alerts-to-a-webhook/).

## Tick it

One tick reads one run:

```ts
import { Alerts } from "@smthrs/notifications"
import * as Effect from "effect/Effect"

export const check = (runId: string) =>
  Effect.gen(function*() {
    const alerts = yield* Alerts.AlertRuntime
    const tick = yield* alerts.tick(runId)
    return {
      paged: tick.delivered.map((alert) => alert.condition),
      retrying: tick.failed.map((alert) => alert.condition),
      noRoom: tick.refused.map((alert) => alert.condition),
      alreadySent: tick.suppressed.map((alert) => alert.condition)
    }
  })
```

Call it on whatever schedule suits the deployment. A tick costs the journal
entries committed since the previous one, because the runtime keeps each run's
folded history for the 64 most recently watched runs.

Only two things make `tick` fail. A `Journal.JournalError` is the alerter's own
record channel failing: it read no entries, or it could not write the delivery
record. A `NotificationError` is the notification queue rejecting the alert
outright, which is a producer or storage fault. A sink that refuses the page is
neither: it comes back in `failed` and is retried.

## Decide without a runtime

`Alerts.conditions` and `Alerts.decide` are pure, so a report can answer "what
would page, and when" without admitting anything:

```ts
import type { JournalEvent } from "@smthrs/journal"
import { Alerts } from "@smthrs/notifications"

export const wouldPage = (entries: ReadonlyArray<JournalEvent.Entry>, runId: string, now: number) =>
  Alerts.decide(policy, Alerts.conditions(policy, runId, entries), now)
```

`now` decides whether an alert is raised and never appears in one: every field of
the result, `firedAt` included, comes from the journal. See
[How alerting decides](/concepts/alerting/).

## A worked example

[`examples/src/38-monitor-and-alert.ts`](https://github.com/smithersai/smithers/blob/main/examples/src/38-monitor-and-alert.ts)
runs the whole supervision loop over one SQLite file: two durable runs, a monitor
that beats over them, and the same policy at a production delay and at a zero
delay, so the quiet case and the paging case are visible side by side.
