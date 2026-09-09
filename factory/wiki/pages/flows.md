# Flows, actions and replay

`@smthrs/flow` separates declarations from execution. An action is a stable name with payload, success and error schemas. A flow's pure body composes action calls into a plan. Implementations arrive separately as Effect layers.

## Declare and implement one capability

```ts
import { Action, Flow } from "@smthrs/flow"
import { Effect, Schema } from "effect"

const Describe = Action.make("example/Describe", {
  payload: { name: Schema.String }, success: Schema.String
})
const Greeting = Flow.make("example/Greeting", {
  payload: { name: Schema.String }, success: Schema.String,
  body: (input) => Describe.call(input)
})
const implementation = Describe.toLayer(({ name }) =>
  Effect.succeed(`Hello, ${name}.`))
```

This declares work and its implementation. An executable still provides an engine, an interpreter for the flow, implementation registration and platform services. Declaring the flow does not start it.

## Keep planning pure

The action call records a node; it does not perform the operation. Filesystem reads, model calls and writes belong in action implementations. The same payload must describe the same topology when the runtime evaluates the body again.

Schemas and names are persisted contracts. Changing them changes what an existing execution can decode or reuse, so review such changes with the same care as a persistence migration. Do not add an unrelated table of completed commands to obtain replay; recorded actions already provide that responsibility.

## Read replay claims precisely

The engine records settled work under an execution identity. Running the flow again under that identity can replay its recorded results. The declaration package itself carries no engine: a memory fixture and a durable SQL engine implement the same runtime port.

Use the runtime page for host composition. Use the build graph page for code-input invalidation; a flow's existence alone does not declare every file its implementation reads.
