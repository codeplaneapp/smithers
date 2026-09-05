---
title: "Quickstart"
description: "Declare an action and a flow, compose the layers, run the flow on the in-memory engine, and read a typed result."
sidebar:
  order: 2
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/flow/docs/quickstart.md"
---

This quickstart runs one flow end to end on the in-memory engine. Nothing here
touches a database or the network, and the result arrives as a typed value
decoded by the schema you declared.

A runnable copy of this program is published in the Smithers examples,
[`01-define-and-run.ts`](https://github.com/smithersai/smithers/blob/main/examples/src/01-define-and-run.ts).

## Prerequisites

- Node.js 22.19.0 or later.
- A package with the dependencies installed:

```bash
pnpm add @smthrs/flow@next @smthrs/engine@next effect@4.0.0-rc.112 @effect/platform-node
```

## Declare the action and the flow

Create `quickstart.ts`. `Action.make` with a string tag is the declared form:
schemas and a stable name, no code.

```ts
import { Action, Flow } from "@smthrs/flow"
import * as Schema from "effect/Schema"

export const Greet = Action.make("examples/Greet", {
  payload: { name: Schema.String },
  success: Schema.String
})

export const Greeting = Flow.make("examples/Greeting", {
  payload: { name: Schema.String },
  success: Schema.String,
  body: (payload) => Greet.call(payload)
})
```

`Greet.call(payload)` records one node and runs nothing. It also puts a
requirement in the node's type, which `Flow.make` reads off the body: the flow
now says in its own type that it names an implementation it does not carry.

## Attach the implementation and compose the layers

`toLayer` is where the code lives. `Interpreter.layer` registers the flow and
installs the handler that walks its body:

```ts
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { FlowEngine } from "@smthrs/engine"
import { Action, Interpreter } from "@smthrs/flow"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"

const GreetingLayer = Layer.mergeAll(
  Greet.toLayer(({ name }) => Effect.succeed(`Hello, ${name}.`)),
  Interpreter.layer(Greeting)
).pipe(
  Layer.provideMerge(Action.layerImplementations),
  Layer.provideMerge(FlowEngine.layerMemory),
  Layer.provideMerge(NodeCrypto.layer)
)
```

Three details in that pipe matter, and each one is a rule rather than a
preference:

- `Action.layerImplementations` goes **under** the implementation layers, with
  `Layer.provideMerge`. Filing an implementation in the table is a build-time
  effect, so the table has to exist while the layers above it are built.
- `FlowEngine.layerMemory` supplies the `FlowRuntime` port. Swap it for the
  durable engine from [`@smthrs/engine-store`](https://engine-store.smithers.sh/reference/api/) and nothing
  above changes.
- `NodeCrypto.layer` supplies `Crypto`. Every dispatch is recorded under a
  derived step identity, so the engine needs a digest even in memory.

## Run it

`execute` takes the payload and an execution id:

```ts
export const main: Effect.Effect<string> = Greeting.execute(
  { name: "Ada" },
  { executionId: "greeting-ada-1" }
).pipe(
  // A payload that misses the flow's schema is a typed failure, not a defect.
  // This payload is statically valid, so a refusal here would be a bug.
  Effect.orDie,
  Effect.provide(GreetingLayer)
)

console.log(await Effect.runPromise(main))
```

Run the file with your TypeScript runner. The output is the decoded success
value:

```text
Hello, Ada.
```

## Run it twice

Execute the same flow again under the same execution id. The action does not run
a second time:

```ts
export const twice: Effect.Effect<string> = Effect.gen(function*() {
  const run = Effect.orDie(
    Greeting.execute({ name: "Ada" }, { executionId: "greeting-ada-1" })
  )
  yield* run
  return yield* run
}).pipe(Effect.provide(GreetingLayer))
```

An execution id names one run. The second call finds the run that already
settled and answers with its result instead of starting another, and a durable
engine behaves the same way across a restart: it rebuilds the plan, derives the
same key for the same node, reads the recorded result, and reaches only the
steps that never settled. That is what separating the plan from the code buys.
Identity is a function of the declaration, so a repeat is a read.

An execution id is also a claim about what the run is. Reusing one for a
different flow, or for a different payload, is refused rather than silently
joined.

## What just happened

`Greeting.execute` asked the runtime for an execution under
`greeting-ada-1`. The interpreter built the graph of the body, walked it, and
dispatched `examples/Greet` through the engine, which recorded the attempt and
its result. Because the body is pure and the graph is built before anything runs,
the same payload always produces the same nodes with the same keys, on this
process and on the next one.

## Next steps

- [Flows and actions](/concepts/flows-and-actions/): why the implementation
  attaches separately, and what the requirement channel buys you.
- [Build a body](/guides/build-a-body/): sequencing, fan-out, branches, and
  recovering from a typed failure.
- [Testing](/testing/): the same in-memory composition as a test habit.
