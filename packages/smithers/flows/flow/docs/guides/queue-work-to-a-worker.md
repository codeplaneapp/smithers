---
title: "Hand work to a durable worker"
description: "Declare a durable queue, suspend a flow until a worker records its result, and run the worker as a layer with bounded concurrency."
sidebar:
  order: 10
---

A `DurableQueue` moves work out of the flow that asked for it without losing the
answer. The flow offers a payload, parks, and resumes with whatever exit the
worker recorded. Both halves are persisted, so neither the request nor the reply
depends on the process that made it.

## Declare the queue

```ts
import { DurableQueue } from "@smthrs/flow"
import * as Schema from "effect/Schema"

export const Renders = DurableQueue.make({
  name: "Renders",
  payload: Schema.Struct({ page: Schema.String }),
  success: Schema.String,
  idempotencyKey: ({ page }) => page
})
```

`idempotencyKey` is required. It is what identifies one item, so two offers of
the same page are one piece of work rather than two. `success` defaults to
`Schema.Void` and `error` to `Schema.Never`.

## Offer work from a flow

```ts
const rendered = DurableQueue.process(Renders, { page: "home" })
```

`process` offers the payload under the name `DurableQueue/<name>`, attaches a
completion token, and suspends the execution until a worker records the handler's
exit against it. The success and error channels are the queue's declared schemas,
so the caller sees the worker's own outcome.

Two things are deliberately defects rather than typed failures: a payload that
fails the queue's schema, and the final offer failure of an exhausted retry
schedule. Both would otherwise pollute an error channel that belongs to the
worker.

`retrySchedule` bounds how a failing offer is retried. The default retries with
exponential delays capped at one minute and never gives up, so a caller that
wants a bound supplies its own:

```ts
import * as Schedule from "effect/Schedule"

const bounded = DurableQueue.process(Renders, { page: "home" }, {
  retrySchedule: Schedule.recurs(5)
})
```

## Run the worker

`DurableQueue.worker` is the layer form: it forks the worker into the layer's
scope, so it starts with the composition and stops with it.

```ts
import * as Effect from "effect/Effect"

export const RendersWorker = DurableQueue.worker(
  Renders,
  ({ page }) => Effect.succeed(`<html>${page}</html>`),
  { concurrency: 4 }
)
```

`concurrency` defaults to `1` and must be a positive safe integer;
`DurableQueue.makeWorker` and `DurableQueue.worker` throw a `RangeError`
otherwise. `makeWorker` is the underlying effect, for a host that wants to fork
it itself.

The handler's exit is what the waiting flow receives. A handler that fails with
the queue's declared error type resumes the caller with that typed failure; a
handler that dies resumes it with a defect.

## When to reach for it

A durable queue is the right shape when the work has a different lifetime or a
different scaling story from the flow that asked for it: a render farm, a batch
of uploads, anything where the caller should park rather than hold a slot. When
the work belongs to the same run, an action is simpler and keeps the step in the
plan. When it is its own unit of work with its own journal,
[a child execution](./run-a-child-flow.md) is the closer fit.

## Related pages

- [Wait for an external signal](./wait-for-an-external-signal.md): the deferred
  and token machinery the queue's reply channel is built on.
- [Suspension and replay](../concepts/suspension-and-replay.md): what the caller
  is doing while the worker works.
