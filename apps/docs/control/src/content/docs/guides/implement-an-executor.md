---
title: "Connect an execution engine"
description: "Implement ControlExecutor so plan launches start real runs and cancels, signals, and resumes reach the engine: the five methods, the answers each one may give, and why a launch forks."
sidebar:
  order: 8
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/control/docs/guides/implement-an-executor.md"
---

`ControlExecutor` is the seam between authority and execution. The plane hands
work over and learns only what the executor did with it.

Without it, the plane records facts nobody reads: a cancel that answers
`ClaimLost` to every process but the owner, a signal a parked run never sees,
and a resume nothing subscribes to.

## The five methods

```ts
interface Service {
  readonly launch: (input: Launch) => Effect.Effect<Acceptance, LaunchFailed>
  readonly requestCancel: (input: CancelRequest) => Effect.Effect<CancelRecord, PersistenceError>
  readonly deliverSignal: (input: Signal) => Effect.Effect<SignalDelivery, PersistenceError>
  readonly resumeRun: (input: ResumeRequest) => Effect.Effect<ResumeUptake, PersistenceError>
  readonly settleCancelledPark: (input: CancelRequest) => Effect.Effect<void, PersistenceError>
}
```

Each answer is a small closed vocabulary, and every value in it is a real
deployment:

| Method                | Answer                             | Means                                                                      |
| --------------------- | ---------------------------------- | -------------------------------------------------------------------------- |
| `launch`              | `accepted`                         | This executor took the launch. The plane writes `running`.                 |
|                       | `pending`                          | It queued the launch. The plane releases the row as `control.run.pending`. |
|                       | fails `LaunchFailed`               | Nothing will ever drive this run. The plane settles the row as `failed`.   |
| `requestCancel`       | `recorded`                         | This call set `cancel_requested_at_ms` on the engine row.                  |
|                       | `already-requested`                | The column was already set, so the attribution record already exists.      |
|                       | `unknown`                          | This executor's engine has no row for the run.                             |
|                       | `{ _tag: "Terminal", status }`     | The engine row has already settled.                                        |
| `deliverSignal`       | `delivered`, `no-match`, `unknown` | See [Deliver a signal](/guides/signal-a-run/).                                 |
| `resumeRun`           | `resuming`                         | This executor hosts the run, took the fence, and is re-driving it.         |
|                       | `unknown`                          | It drives no execution for this run.                                       |
| `settleCancelledPark` |                                    | Finishes a parked execution whose cancellation is already durable.         |

`already-requested` is not a detail. The write is first-writer-wins and every
repeat of `cancel` re-runs the whole mutation, so answering `recorded` to all
of them journals one `control.run.cancel-requested` per ask for a single
cancellation.

`settleCancelledPark` exists because a park has no owner, so nothing is driving
the run and nothing reads the request `requestCancel` wrote. The engine's
parked-run sweep does, once per heartbeat, but a short-lived `smthrs cancel`
process writes the request at the very end of its life and exits first. The
plane calls this _after_ the cancel mutation commits, never inside it: driving
a run re-enters the engine, whose writes would wait on the writer the
transaction holds.

## Start from the noop

`ControlExecutor.makeNoop` answers the honest absence for every method, so an
implementation overrides only what it supports:

```ts
import * as ControlExecutor from "@smthrs/control/ControlExecutor"
import * as Effect from "effect/Effect"

const executor = ControlExecutor.makeNoop({
  launch: ({ plan, run }) =>
    Effect.sync(() => {
      queue.push({ flowId: plan.card.flowId, runId: run.runId })
      return "pending" as const
    })
})
```

`ControlExecutor.layer(executor)` and `ControlExecutor.layerNoop(overrides)`
provide it.

## Start the run the plane minted

`launch` receives the stored plan and the run row the plane has created, and
it must start _that_ run: `run.runId` is the execution id, so the events the
engine journals and the row the plane projects name one run.

```ts
const executorLayer = Layer.effect(ControlExecutor.ControlExecutor)(
  Effect.gen(function*() {
    const services = yield* Effect.context<FlowRuntime.FlowRuntime | Registry.Registry>()

    return ControlExecutor.makeNoop({
      launch: ({ plan, run }) =>
        Effect.gen(function*() {
          const executable = yield* Executable.fromRegistry(plan.card.flowId, bridge)
          const start = yield* Deferred.make<void>()
          Effect.runForkWith(services)(
            Deferred.await(start).pipe(
              Effect.andThen(executable.flow.execute(
                { input: plan.decodedInput },
                { executionId: run.runId, discard: true }
              ))
            )
          )
          driving.push({ runId: run.runId, start })
          return "accepted" as const
        }).pipe(Effect.provide(services), Effect.orDie)
    })
  })
)
```

It forks rather than running inline, and the fork waits on a latch. `run`
writes `running` on the row _after_ the executor answers `accepted`, so an
executor that let the run park first would have that write land on top of the
park. Releasing the latch after the receipt is in hand orders the two writes.

## Mirror the engine's status back

The plane cannot see into the engine's database, so an executor that walked
away after starting a run would leave every run reading `running` forever.
Reading the engine's own row back and writing the plane's vocabulary onto the
plane's row is the whole of that duty:

```ts
const mirror = (runId: string) =>
  Effect.gen(function*() {
    const runs = yield* RunStore.RunStore
    const row = yield* runs.get(runId)
    const fence = yield* plane.claimFence(runId)
    yield* plane.writeStatus(runId, fence, row.status === "suspended" ? "parked" : row.status)
  })
```

The engine calls a parked run `suspended`; an operator calls it `parked`.

The complete, runnable bridge, with discovery, two databases, and one shared
journal, is
[`examples/src/24-control-plane-and-gateway.ts`](https://github.com/smithersai/smithers/blob/main/examples/src/24-control-plane-and-gateway.ts).

## Where to go next

- [Ownership, fences, and claims](/concepts/ownership/): what
  `claimFence` and `writeStatus` are doing.
- [Cancel a run, and restart one](/guides/cancel-and-resume/): the sequence
  `requestCancel` and `settleCancelledPark` sit inside.
- [Store control state in a database](/guides/durable-storage/): the other half of
  a real deployment.
