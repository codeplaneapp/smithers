---
title: "@smthrs/flow"
description: "The flow authoring model: typed flows whose bodies are plans, actions whose implementations attach as layers, durable waits, retry policy, and the runtime port they all execute against."
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/flow/docs/README.md"
---

`@smthrs/flow` is the vocabulary you write a durable program in. It defines two
nouns and the port they run against, and it executes nothing itself.

- An **action** is one recorded operation. `Action.make("payments/Charge", ...)`
  declares its name and schemas; `Charge.toLayer(...)` attaches the code
  separately. A declaration is pure data that travels anywhere, so the compiler
  can tell you an implementation is missing before a run reaches it.
- A **flow** is a durable program. `Flow.make("payments/Checkout", ...)` takes a
  required pure `body`, and that body names actions rather than calling them.
  Building the plan a body describes runs nothing, so the whole shape of a round
  is known before its first step.
- A **runtime** records, suspends, and resumes. `FlowRuntime` is the service tag
  this package is written against. [`@smthrs/engine`](https://engine.smithers.sh/reference/api/) implements it,
  and [`@smthrs/engine-store`](https://engine-store.smithers.sh/reference/api/) makes that implementation
  durable.

The split is what makes a crash survivable. Because the body is a plan and every
step has a stable key, a re-driven execution rebuilds the same keys, replays the
results already recorded, and reaches the unsettled step deterministically.

## Who uses this package

Workflow authors declare flows and actions with it. Host and engine authors
implement `FlowRuntime` against it. Nothing here binds to Node: the whole package
bundles for the browser, and durability comes from whichever runtime you provide.

## Install

```bash
pnpm add @smthrs/flow
```

For the peer version of `effect`, the import forms, and the packages a runnable
composition adds, see [Installation](/installation/).

## The smallest complete program

An action declared without code, a flow whose body names it, and the layer that
attaches the two:

```ts
import { Action, Flow, Interpreter } from "@smthrs/flow"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"

const Greet = Action.make("examples/Greet", {
  payload: { name: Schema.String },
  success: Schema.String
})

const Greeting = Flow.make("examples/Greeting", {
  payload: { name: Schema.String },
  success: Schema.String,
  body: (payload) => Greet.call(payload)
})

export const layer = Layer.mergeAll(
  Greet.toLayer(({ name }) => Effect.succeed(`Hello, ${name}.`)),
  Interpreter.layer(Greeting)
).pipe(Layer.provideMerge(Action.layerImplementations))
```

`Greet.call(payload)` records one plan node and executes nothing. `Greet.toLayer`
provides the requirement that call put in the body's type, so a composition that
forgot an implementation does not compile. Provide an engine and a crypto
service beneath this layer and `Greeting.execute` runs. The
[Quickstart](/quickstart/) does exactly that, end to end.

## The package at a glance

The root entry point exports these namespaces, and each is also importable from
`@smthrs/flow/<Namespace>`:

| Namespace         | What it is                                                                                                                      |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `Flow`            | Typed durable flow declarations: `make`, the execution lifecycle, results, and the trampoline outcome vocabulary.               |
| `Action`          | Durable action declarations, tiers, idempotency identity, file boundaries, cache policy, and the implementation table.          |
| `Interpreter`     | The drive: `Interpreter.layer(flow)` registers a flow and installs the handler that walks its body.                             |
| `Graph`           | Plan-time graph building. `Graph.build` turns a body and a payload into nodes, edges, and diagnostics without running anything. |
| `Sleep`           | The declared `system/sleep` step: a wait for time to pass, as an ordinary keyed plan node.                                      |
| `WaitFor`         | The declared `system/wait-for` step: a rendezvous with something outside the run.                                               |
| `Poll`            | The durable poller: attempts as rounds, waits as durable timers.                                                                |
| `HumanTask`       | Asking a person something: typed answers, re-asking, and a deadline.                                                            |
| `DurableClock`    | A timer whose completion is persisted, so a wait outlives the process holding it.                                               |
| `DurableDeferred` | A persisted promise, and the tokens another process completes it through.                                                       |
| `DurableQueue`    | Sending work to a persisted worker and awaiting its result.                                                                     |
| `RetryPolicy`     | Retry as plain data, so the next delay is derived from a persisted attempt count.                                               |
| `StepIdentity`    | The one canonical derivation of ordinal step identity.                                                                          |
| `FlowRuntime`     | The execution port this package declares and depends on nothing to implement.                                                   |

Every export, with its signature and defaults, is on the
[export reference](/reference/flow/). The
[API reference](/reference/api/) explains how the pieces fit together.

## Where to go next

- [Installation](/installation/): requirements, import forms, and the packages
  a runnable composition adds.
- [Quickstart](/quickstart/): declare a flow, run it on the in-memory engine,
  and read a typed result.
- Concepts: [flows and actions](/concepts/flows-and-actions/),
  [bodies are plans](/concepts/bodies-and-plans/),
  [execution identity](/concepts/execution-identity/),
  [suspension and replay](/concepts/suspension-and-replay/),
  [trampoline rounds](/concepts/trampoline-rounds/), and
  [the runtime port](/concepts/the-runtime-port/).
- Guides: [implement an action](/guides/implement-an-action/),
  [build a body](/guides/build-a-body/),
  [retry a failing action](/guides/retry-a-failing-action/),
  [wait for a deadline](/guides/wait-for-a-deadline/),
  [wait for an external signal](/guides/wait-for-an-external-signal/),
  [ask a person](/guides/ask-a-person/),
  [poll until ready](/guides/poll-until-ready/),
  [run a child flow](/guides/run-a-child-flow/),
  [cancel and roll back](/guides/cancel-and-roll-back/),
  [queue work to a worker](/guides/queue-work-to-a-worker/),
  [inspect the plan](/guides/inspect-the-plan/), and
  [reuse a recorded result](/guides/reuse-a-recorded-result/).
- [Testing](/testing/): run a flow in a test without a durable engine.
- [Troubleshooting](/troubleshooting/): the refusals this package raises, what
  causes each one, and what to change.
