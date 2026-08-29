---
description: "Waits, signals, approvals, child flows, cancellation, and recovery: the six ways a run stops and starts again."
---

# Durable waits and control

A run that waits does not hold a process. It parks: the engine writes why it is
waiting, releases ownership, and stops. Something else, a clock, a signal, an
approval, a child flow, or an operator, makes it runnable again, and the next
process to claim it replays the journal and continues from the frontier.

This page covers the six ways that happens.

## Waits

| Primitive | Parks until |
| --- | --- |
| `DurableClock.sleep` | an absolute wake time passes |
| `DurableDeferred.await` | another process completes the deferred's token |
| `DurableQueue.process` | offered work settles |
| `WaitFor.action` | a named signal arrives |
| `WithApproval.withApproval` | a person approves or denies |

Each writes a waiting row with a reason (`timer`, `event`, `approval`, or
`quota`) and a wake time where one exists. `smithers ps --status parked` lists
them, and `smithers status RUN_ID` says which primitive is holding the run.

The wait is durable, not the caller. Nothing is lost when the process that
started the run exits while it is parked.

## Signals

A signal is a named JSON payload delivered to a parked run.

```bash
smithers signal RUN_ID '{"name":"approved","payload":{"by":"ops"}}'
```

Delivery is durable and idempotent. The control plane persists the message,
journals `control.signal.delivered`, and completes the deferred that
`WaitFor` is holding, keyed by signal name. A run parked on `WaitFor` wakes
within one heartbeat tick. The CLI derives its idempotency key from the run id
and a digest of the payload, so two different signals to one run are two
mutations and the same signal twice is one.

## Approvals

An approval parks the run as `waiting-approval` and records the exact payload a
decision needs. Plan-level approval gates a `deployClass` flow before it
launches; node-level approval gates one step inside a running flow.

```bash
smithers ps --status waiting-approval
smithers approve '<payload>' --scope run
```

`--scope` is `once`, `run`, or `remembered`. The server stamps the acting
principal; the client cannot claim one. Approving a node target resumes the
parked run server-side, so a UI does not need a second call. See
[`Control.Approve`](/control/approve).

## Child flows

A child flow is a run with a durable parent edge. The default is attached: the
caller waits for the result, and the parent's terminal transaction
cancel-requests every attached descendant in the same write. Detached children
are not available in this release; `ChildFlows` fails with a typed
`unsupported` error rather than leaving an orphan.

Cycles are impossible by construction. Recording the parent edge walks the
child-to-parent chain inside one transaction and rolls back with
`RunParentCycleError`. See [child flows](/concepts/subflows).

## Cancellation

```bash
smithers cancel RUN_ID
```

Cancellation is durable and cross-process. The request is recorded on the run
row whichever process owns the run, and the owning process delivers it within
one heartbeat tick, interrupting the local fiber and cascading to every linked
descendant. Cancelling a terminal run returns the terminal receipt and writes
no event.

Cancellation also reaches the operating system. Every child process the kernel
spawner started runs in its own process group, and cancelling the run kills the
group, including a child that ignores `SIGTERM`. What cancellation does not
cover is a hard-killed engine: no durable process registry exists, so
process groups outlive a `SIGKILL` of the engine itself and a restarted engine
does not reap them.

There is one cancellation path. `FlowRuntime.interruptUnsafe` on the durable
engine fails with `unsafe_interrupt_unsupported` instead of forcing a stop
without cleanup.

## Recovery

Recovery is a running engine process with the flow registered. There is no
supervisor process: nothing in this release watches for an abandoned run and
launches a process for it.

What does happen automatically, in a process that is already running:

- a one-second heartbeat renews ownership of the runs it drives;
- runs whose heartbeat is older than 30 seconds are stale, and the sweep
  re-drives up to 64 of them per tick through the ordinary claim path;
- stealing a run requires liveness evidence, so a live peer keeps its run and
  the second caller gets `ClaimLost`;
- a wake for a flow the sweeping process has not registered logs one warning
  per run and leaves the row parked.

To resume a specific run by hand:

```bash
smithers run --resume RUN_ID
```

That is join-or-claim: it joins the owner when one is alive and claims the run
when none is. Wakes published in another process land through the heartbeat
sweep and the cancel poll, not through an event bus.
