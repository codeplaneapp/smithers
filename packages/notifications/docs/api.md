This page covers the parts a caller touches: admitting a notification into the
durable queue, draining it at a turn boundary, the steering vocabulary a payload
may carry, and the alert policy that writes a notification nobody asked for.

## Admission and drain

`NotificationQueue.Service` is the whole contract. A writer admits a
notification and receives an `AdmissionReceipt`; a reader drains with a
`DrainInput` and receives a `DrainReceipt`. Admission and drain are separate
operations because they happen in different processes at different times: the
control plane admits, and the harness drains at a safe point in its own turn.
Nothing is delivered between those two moments, which is the point. A
notification that arrives mid-turn would change what the model is looking at
while it is looking at it.

`NotificationQueue.layer` is the journal-backed implementation and is the one to
use. It needs a `Journal.Journal`, because durability here means the queue
survives the process: a notification admitted by a host that then dies is
drained by the next one. `NotificationQueue.layerNoop` and
`NotificationQueue.makeNoop` accept the same calls and keep nothing, for a test
that needs the seam present and does not care what it holds.

## What a payload may say

`SteerPayload.SteerPayload` is a union of four shapes: `MessagePayload` adds
text the model reads, `SeatPayload` changes which seat serves the run,
`ThinkingPayload` changes the reasoning effort through `SteerPayload.Thinking`
(`none` through `xhigh`), and `ToolsPayload` changes the tools in scope.

The vocabulary lives in this package rather than in either package that uses it.
A control plane admits a steer and a harness drains it, and neither may depend
on the other, so the shape they have to agree on belongs beneath both.

## Pending state and its bound

`NotificationState` is the pure queue state, with no I/O and no journal, so the
promotion rules can be tested directly. `Projection` is the journal projection
that answers what is pending for a run, and it retains a bounded number per run
rather than an unbounded backlog. A run nobody drains would otherwise
accumulate forever, and the bound makes the worst case a known quantity instead
of a function of how long the run has been ignored.

## Alerts

A notification answers "tell this run something". An alert answers the question
nobody is around to ask: a run has waited an hour for an approval and the person
who could grant it does not know.

`Alerts.Policy` holds `Alerts.Rule` values, each pairing an `Alerts.Detector`
with an `Alerts.Severity` of `info`, `warning`, or `critical`.
`Alerts.defaultDetectors` are the conditions that ship. An alert is admitted as
a coalesced system event on the same queue, so it is durable and delivered once
under the same rules as everything else, and the two paths differ only in who
decides to write one. Delivery outcomes are journaled as
`Alerts.deliveredEventType` and `Alerts.failedEventType`.
