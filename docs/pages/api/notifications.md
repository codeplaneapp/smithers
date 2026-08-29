---
description: "@smthrs/notifications: the durable notification queue and the admission policy that bounds it."
---

# `@smthrs/notifications`

This page is the public API reference for the durable notification queue and
the alert policy over it.

A notification queue answers "tell this run something". An alert answers the
question nobody is around to ask: a run has been waiting for an approval for an
hour, and the person who could grant it does not know. Both are the same
machinery, an alert is admitted as a coalesced system event, and differ only
in who decides to write one.

## Queue

`NotificationQueue` admits a notification exactly once, drains what a turn
boundary is allowed to deliver, and reports what is still pending.
`NotificationQueue.layer` is journal-backed: admission and drain evidence go
through `emitDurable`, so both return only after the entry is durably
committed.

A notification is a `human-steer` (delivered at the next turn close), a
`human-followup` (delivered when the run would otherwise idle), or a
`system-event` (also idle-delivered, and coalescing on a declared key).

## Steering vocabulary

`SteerPayload` is what a control plane writes into a `human-steer` and a
harness reads back:

| Payload | Field | What the turn does |
| --- | --- | --- |
| `Message` | `body` | Inserts the body into the transcript. |
| `Seat` | `seat` | Runs the turn on that model seat. |
| `Thinking` | `thinking` | Runs the turn at that thinking level. |
| `Tools` | `toolNames` | Adds those tools to the active set. |

`decode` returns nothing for a payload that is not one of the four, which keeps
a system event or a webhook body an ordinary transcript insert rather than a
failed drain.

## Alerts

`Alerts.Policy` names the conditions to watch, the delay each must outlive, and
who owns it:

```ts
const policy: Alerts.Policy = {
  defaults: { severity: "warning", owner: "oncall" },
  rules: {
    "waiting-approval": { afterMs: 3_600_000, runbook: "https://runbook/approvals" },
    stalled: { afterMs: 600_000, severity: "critical" }
  }
}
```

A condition is a payload field with a value, and `defaultDetectors` covers the
four a control plane already journals:

| Condition | Field | Value | Written by |
| --- | --- | --- | --- |
| `waiting-approval` | `status` | `waiting-approval` | every `control.run.*` entry |
| `failed` | `status` | `failed` | every `control.run.*` entry |
| `stalled` | `health` | `stalled` | every `control.monitor.beat` |
| `quota-parked` | `waitingReason` | `quota` | whichever supervisor journals a park reason |

An entry that carries a detector's field opens the condition when the value
matches and closes it when it does not, so a resume clears an approval alert
without a second vocabulary for "cleared". Entries the detector does not name
are ignored, so a monitor beat cannot close an approval wait. A deployment with
a different vocabulary supplies `policy.detectors` instead of forking the
module.

### Journal time

A condition's clock starts at the journal entry that opened it, so the decision
is replayable: the same journal produces the same alerts, in any process, at
any time. A restart re-derives every open condition from the entries rather
than from a timer it lost.

### Delivered at least once

`AlertRuntime.tick(runId)` reads the run's journal, derives the open
conditions, decides which have outlived their delay, and for each one that has
not already been delivered: admits a coalesced system event, sends it to the
`Sink`, and journals `flows.alerts.delivered`.

The admission comes first because it is idempotent on the alert id and the send
is not. A process that dies between them costs a duplicate admission, which the
queue drops, rather than a duplicate page; the replacement process delivers on
its next tick. A sink that fails journals `flows.alerts.failed` and the alert is
retried on the next tick, because a refused page is not a delivered page.

The delivery record is written **after** the sink accepted the page, so a
process that dies in that window has paged and left no evidence of it, and the
next tick pages again. That is the whole gap between at-least-once and
exactly-once, and it is deliberate: recording the delivery first would turn the
same crash into a page nobody ever receives.

`Sink.deliver` therefore has to be idempotent on the alert id:

```ts
const layerPager = Layer.succeed(Alerts.Sink)({
  deliver: (alert) => page({ dedupeKey: Alerts.alertId(alert), body: alert })
})
```

`Alerts.alertId(alert)` is stable for the life of one condition and every field
of the alert is derived from the journal: `firedAt` is `since` plus the rule's
`afterMs`, not the wall clock of whichever tick noticed, so the same alert is
byte-identical on every attempt and the id is a sound deduplication key. A sink
without one will occasionally page twice about one condition.

The alert id carries the time the condition opened, so a condition that clears
and re-opens is a new alert. The second approval wait is not the first one.

`tick` fails with a `JournalError` when the alerter's own record channel fails
and with a `NotificationError` when the queue refuses the admission. Neither is
a sink failure: a page the sink refused is journaled as `flows.alerts.failed`,
returned in `Tick.failed`, and retried on the next tick.

`Sink` is injected: `layerNoop` accepts everything and sends nothing, and
`layerWebhook({ url })` POSTs each alert and treats a non-2xx response as a
failure.

See [`@smthrs/control`](/api/control) for the run conditions the entries come
from.
