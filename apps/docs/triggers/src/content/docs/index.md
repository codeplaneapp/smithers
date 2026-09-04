---
title: "@smthrs/triggers"
description: "Durable cron triggers and verified inbound channels for flows: a scheduler that survives restarts, a claim protocol that keeps two hosts from firing one occurrence twice, and webhook doors that carry no execution authority."
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/agent/triggers/docs/README.md"
---

A flow starts one of three ways: a person asks for it, a clock reaches a
boundary, or something outside sends a request. `@smthrs/triggers` owns the
last two.

The package is deliberately small in authority and large in bookkeeping.
A trigger names a flow id, a JSON input, and a cron expression. A channel
authenticates opaque bytes and maps them onto a control-plane start or
signal. Neither one executes anything: the launch goes through
[`@smthrs/control`](https://control.smithers.sh/reference/api/), so the target flow's envelope, approvals,
and permission checks apply unchanged.

What the package spends its code on is the part that is hard to get right:
firing exactly once across two hosts, deciding what a boundary means when the
previous run is still going, and knowing what a process owes after it was down
for six hours.

## Who uses this package

Hosts use it. A host composes the scheduler into its runtime so registered
triggers keep firing, and declares webhook doors so an outside system can start
a flow. Flow authors do not import it: a trigger points at a flow by id, and
the flow itself never learns that a clock started it.

## Availability

`@smthrs/triggers` is a private workspace package for the 1.0.0-rc.0 release.
Only code in this workspace may depend on it, and it is not published to npm.
See [Installation](/installation/).

## The smallest declaration

A trigger is data. `Trigger.make` decodes it, fills the policy defaults, and
refuses a cron expression that the calendar never satisfies:

```ts
import * as Trigger from "@smthrs/triggers/Trigger"

const nightly = Trigger.make({
  id: "nightly-report",
  flowId: "reports/nightly",
  input: { channel: "#ops" },
  cron: "0 3 * * *",
  timezone: "UTC",
  overlap: "skip",
  catchUp: "one",
  maxCatchUp: 1,
  enabled: true
})
```

`nightly` is an `Effect<Trigger, TriggerError>`. Registering it in a
`TriggerStore` makes it durable, and a running `Scheduler` fires it from there.
For the whole path, including the launch, see the
[Quickstart](/quickstart/).

## The package at a glance

The root entry point exports these namespaces, and each is also importable from
`@smthrs/triggers/<Module>`:

| Namespace         | What it is                                                                                   |
| ----------------- | -------------------------------------------------------------------------------------------- |
| `Trigger`         | The trigger declaration: a flow id, a JSON input, a schedule, and an enabled flag.           |
| `Schedule`        | The reusable schedule half of a declaration: cron, timezone, and the two policies.           |
| `Cron`            | Typed wrappers around Effect's cron: parse, next, previous, and a bounded occurrence search. |
| `Overlap`         | The pure decision for an occurrence that arrives while a run is in flight.                   |
| `CatchUp`         | The pure computation of what a trigger owes after downtime, bounded by its declaration.      |
| `TriggerStore`    | The durable state contract: registration, listing, the claim protocol, and results.          |
| `SqlTriggerStore` | The SQLite implementation of that contract, with its own migrations.                         |
| `Scheduler`       | The Clock-driven poller, and the `Runner` port it launches through.                          |
| `Channel`         | The authority-free inbound channel declaration: verify, then map to a start or a signal.     |
| `Webhook`         | A verified webhook door built on `Channel`, dispatching only through Control.                |
| `TriggerError`    | The one failure type, carrying a stable code and an optional field path.                     |

Every export, with signatures and guarantees, is on the
[API reference](/reference/api/).

## Where to go next

- [Installation](/installation/): requirements, import forms, and the
  packages a running host adds.
- [Quickstart](/quickstart/): register a trigger and watch it launch, end to
  end, in milliseconds.
- Concepts: [cron schedules and occurrences](/concepts/schedules/),
  [overlap and catch-up](/concepts/policies/),
  [the claim protocol](/concepts/claim-protocol/), and
  [authority-free channels](/concepts/channels/).
- Guides: [declare and register a trigger](/guides/declare-a-trigger/),
  [run the scheduler in a host](/guides/run-the-scheduler/),
  [choose an overlap and catch-up policy](/guides/choose-a-policy/),
  [ingest a verified webhook](/guides/ingest-a-webhook/), and
  [test trigger code](/guides/testing/).
- [Troubleshooting](/troubleshooting/): every failure code, what causes it,
  and what to change.
