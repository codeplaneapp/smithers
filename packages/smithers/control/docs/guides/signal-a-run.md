---
title: "Deliver a signal to a waiting run"
description: "Record a named durable fact for a run, let the executor complete the wait point it names, and understand why a signal that matches no open wait is refused where it arrives."
sidebar:
  order: 5
---

A signal is a durable fact delivered to a run: a name and a JSON payload.

```ts
import { Control } from "@smthrs/control/Control"
import * as Effect from "effect/Effect"

const signal = Effect.gen(function*() {
  const control = yield* Control
  return yield* control.signal({
    runId: "run-17",
    signal: { name: "clearance", payload: { approved: true, by: "release-manager" } },
    idempotencyKey: "signal:run-17:clearance"
  })
})
```

A signal says something happened. It does not decide who runs next, which is
what separates it from a [steer](./steer-a-run.md) and from a
[resume](./cancel-and-resume.md).

## What the executor decides

`Control.signal` asks the executor to complete the run's open `WaitFor` wait
point with the payload, and the executor's answer decides the receipt:

| `SignalDelivery` | Meaning                                                           | Receipt          |
| ---------------- | ----------------------------------------------------------------- | ---------------- |
| `delivered`      | The deferred the run is parked on was completed and the run woke. | `Accepted`       |
| `no-match`       | The run is parked, and parked on something else.                  | `NoMatchingWait` |
| `unknown`        | This executor drives no execution for the run.                    | `Accepted`       |

`no-match` is refused where it arrives rather than recorded, because recording
a delivery here would leave an operator watching a signal that never lands.
The failure names the wait point:

```text
no wait point named "clearance" is open on run run-17. Read `smthrs status run-17` to see what that run is waiting for.
```

`unknown` is the answer for a composition with no executor, or one whose engine
never heard of the run. The recorded message is then the whole delivery, and
the executor that eventually drives the run replays it at its next start.

Delivery happens _outside_ the mutation's write transaction, because completing
a wait point re-drives the run and the engine's own journal flush would wait on
the writer that transaction holds. A crash between delivery and record leaves
the run awake with no control record, which is the survivable half of the pair.

The idempotency lookup runs first, and outside the mutation too. A re-sent
signal answers with its original receipt rather than being matched against a
wait point its own first delivery already closed.

## Completing the wait point yourself

Turning a recorded signal into a completed wait point is the host's job,
because only the flow author knows which wait points exist and what value each
carries. At its smallest, that host reads the signals the plane admitted and
completes the matching `WaitFor` deferred:

```ts
import * as ControlRuntime from "@smthrs/control/ControlRuntime"
import { DurableDeferred, WaitFor } from "@smthrs/flow"
import * as Effect from "effect/Effect"

const deliverSignals = (runId: string) =>
  Effect.gen(function*() {
    const runtime = yield* ControlRuntime.ControlRuntime
    for (const signal of yield* runtime.deliveredSignals(runId)) {
      const waitPoint = WaitFor.deferred(signal.name)
      yield* DurableDeferred.succeed(waitPoint, {
        token: DurableDeferred.tokenFromExecutionId(waitPoint, { flow: Ship, executionId: runId }),
        value: signal.payload
      })
    }
  })
```

Naming the wait point after the signal is one convention. A host with several
conventions writes several of these. The runnable original is
[`examples/src/18-approval-and-signal.ts`](https://github.com/smithersai/smithers/blob/main/examples/src/18-approval-and-signal.ts).

## Refusals

| Failure          | Cause                                                                           |
| ---------------- | ------------------------------------------------------------------------------- |
| `RunNotFound`    | This plane has no such run.                                                     |
| `NoMatchingWait` | The run is parked on something else. Carries `runId` and `waitName`.            |
| `InvalidInput`   | The payload is not bounded inert JSON, or the key is not 1 to 1,024 characters. |

A signal to a run that already settled answers `Terminal` and records nothing.

## Where to go next

- [Steer a running agent](./steer-a-run.md): the other durable message, and the
  parks it can end.
- [Connect an execution engine](./implement-an-executor.md): the port that
  turns `delivered` into a woken run.
- [`smthrs signal`](/cli/signal): the operator surface over this verb.
