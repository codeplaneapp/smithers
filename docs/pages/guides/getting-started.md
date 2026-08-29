---
description: "Run a typed flow on the in-memory engine: the shortest executable path through @smthrs/flow and @smthrs/engine."
---

# Getting started

This guide runs a typed flow with the in-memory engine. It is the shortest executable path through `@smthrs/flow` and `@smthrs/engine`; it does not provide process-crash durability.

## Prerequisites

Install Node.js 22.19 or newer, then install the engine and Effect:

```sh
pnpm add @smthrs/flow @smthrs/engine effect
```

For source development in this repository, run `pnpm install` followed by
`pnpm run check` from the workspace root.

## Define and run a flow

```ts
import { FlowEngine } from "@smthrs/engine"
import { Flow } from "@smthrs/flow"
import { Effect, Layer, Schema } from "effect"

const Greeting = Flow.make("example/Greeting", {
  payload: { name: Schema.String },
  success: Schema.String
})

const GreetingLayer = Greeting.toLayer(({ name }) =>
  Effect.succeed(`Hello, ${name}.`)
).pipe(
  Layer.provideMerge(FlowEngine.layerMemory)
)

const program = Greeting.execute(
  { name: "Ada" },
  { executionId: "greeting-ada-1" }
)

console.log(
  await Effect.runPromise(program.pipe(Effect.provide(GreetingLayer)))
)
```

`Flow.make` defines durable schemas and a stable flow tag. `toLayer` registers the handler with whichever `FlowEngine` is supplied. `execute` requires a caller-selected execution ID because this flow did not opt into an idempotency key.

## Derive an execution ID

Use a flow idempotency key only when identical keys truly mean the same logical execution:

```ts
const Greeting = Flow.make("example/Greeting", {
  payload: { name: Schema.String },
  success: Schema.String,
  idempotencyKey: ({ name }) => name.normalize("NFC").toLowerCase()
})

const executionId = yield* Greeting.executionId({ name: "Ada" })
```

An explicit `executionId` always wins. A flow that declares neither takes its ID from the ambient `Flow.CurrentExecutionIds` source, whose default derives one from the flow tag and the payload, so `yield* Greeting.execute({ name: "Ada" })` runs without naming an execution.

## Choose the next guide

- Add durable boundaries in [Writing a flow](/guides/writing-a-flow).
- Replace memory state with the SQL-backed composition in [Assembling a durable engine](/guides/durable-engine).
- Build deterministic fixtures in [Testing](/guides/testing).

The [Durable execution model](/concepts/durable-execution-model) explains what changes when the durable engine is used.
