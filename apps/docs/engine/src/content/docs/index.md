---
title: "@smthrs/engine"
description: "The runtime that executes @smthrs/flow flows: the FlowRuntime port built over a low-level Encoded seam, an in-memory implementation of that seam, and derived RPC and HTTP transports."
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/engine/docs/README.md"
---

`@smthrs/engine` runs the flows that [`@smthrs/flow`](https://flow.smithers.sh/reference/api/) declares.

A `Flow` is a durable program and an `Action` is one recorded operation inside
it. Neither runs anything by itself: both are declarations, and `FlowRuntime`
is the port they talk to. This package is the implementation of that port.

It implements it in two layers, and that split is the design:

- `FlowEngine.makeUnsafe` adapts a low-level `Encoded` implementation into the
  typed `FlowRuntime` service. Step identity, the retry decision, trampoline
  rounds, and the suspended-resume loop all live in the adapter, so every store
  inherits one behavior instead of reimplementing it.
- An `Encoded` implementation decides where state lives. This package ships
  `FlowEngine.layerMemory`, which keeps it in the process.
  [`@smthrs/engine-store`](https://engine-store.smithers.sh/reference/api/) keeps it in a durable journal.

`FlowProxy` and `FlowProxyServer` project the same flows onto a wire. Every
flow gets three operations, execute, discard, and resume, as Effect RPC
definitions or HTTP endpoints, so one process can start a flow that another
process runs.

## Who uses this package

Flow authors use `FlowEngine.layerMemory` to run and test a flow with no store
to configure. Hosts that expose flows to other processes use `FlowProxy` and
`FlowProxyServer`. Store authors implement `FlowEngine.Encoded` and adapt it
with `FlowEngine.makeUnsafe`.

## Install

```bash
pnpm add @smthrs/engine @smthrs/flow
```

For the peer packages a real composition adds, see
[Installation](/installation/).

## The shortest real program

An action declares the work, a flow declares the plan, and the engine runs it:

```ts
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { FlowEngine } from "@smthrs/engine"
import { Action, Flow, Interpreter } from "@smthrs/flow"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"

const Compile = Action.make("build/Compile", {
  payload: { target: Schema.String },
  success: Schema.String
})

const Build = Flow.make("build/Build", {
  payload: { target: Schema.String },
  success: Schema.String,
  body: (payload) => Compile.call(payload)
})

const BuildLayer = Layer.mergeAll(
  Compile.toLayer(({ target }) => Effect.succeed(`${target}.js`)),
  Interpreter.layer(Build)
).pipe(
  Layer.provideMerge(Action.layerImplementations),
  Layer.provideMerge(FlowEngine.layerMemory),
  Layer.provideMerge(NodeCrypto.layer)
)

const built: Effect.Effect<string> = Build.execute(
  { target: "app" },
  { executionId: "build-app-1" }
).pipe(Effect.orDie, Effect.provide(BuildLayer))
```

Running `built` a second time under the same engine and the same
`executionId` returns the recorded result and never calls `Compile` again.
The [Quickstart](/quickstart/) proves that by counting.

## The package at a glance

The root entry point exports three namespaces, each also importable from
`@smthrs/engine/<Namespace>`:

| Namespace         | What it is                                                                                                                                                                                                                                                        |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FlowEngine`      | The runtime: the `Encoded` seam a store implements, the `makeUnsafe` adapter that turns one into the typed port, the in-memory `layerMemory`, per-run instance state, journal and trampoline identity, the compensable snapshot boundary, and the coded refusals. |
| `FlowProxy`       | Client-side and definition-side transport: derives an Effect `RpcGroup` or `HttpApiGroup` from a list of flows.                                                                                                                                                   |
| `FlowProxyServer` | Server-side transport: binds those derived definitions to a running engine.                                                                                                                                                                                       |

Every export, with its signature, is on the
[API reference](/reference/api/). The generated per-export page with field-level
tables is [@smthrs/engine exports](/reference/engine/).

## Where to go next

- [Installation](/installation/): peer packages, the `Crypto` requirement,
  and the import forms.
- [Quickstart](/quickstart/): run a flow, then prove the second run replays.
- Concepts: [the port and the seam](/concepts/port-and-seam/),
  [execution identity](/concepts/execution-identity/),
  [step identity](/concepts/step-identity/),
  [retries and attempts](/concepts/retries/),
  [suspension and cancellation](/concepts/suspension/), and
  [trampoline rounds](/concepts/trampoline-rounds/).
- Guides: [serve flows over RPC or HTTP](/guides/serve-flows/),
  [namespace execution ids per tenant](/guides/namespace-execution-ids/),
  [run a compensable action](/guides/compensable-actions/),
  [implement the Encoded seam](/guides/implement-the-encoded-seam/), and
  [test flows on the in-memory engine](/guides/test-in-memory/).
- [Troubleshooting](/troubleshooting/): each refusal this package raises,
  what causes it, and what to change.
