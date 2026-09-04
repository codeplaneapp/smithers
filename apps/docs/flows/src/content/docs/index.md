---
title: "@smthrs/flows"
description: "One dependency for the whole durable flow engine, plus the two Node-only modules it owns: NodeRuntime, which stands a SQLite-backed engine up, and SandboxedFlow, which runs a child flow's own code inside a provisioned machine."
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/docs/README.md"
---

`@smthrs/flows` is the entry point to the durable flow engine. It is two things
at once, and they are worth separating before you read further.

**It is an aggregate.** The barrel re-exports nineteen `@smthrs/*` engine
packages so one dependency gives you the whole engine surface. It adds no API of
its own on top of them: `Flow`, `Action`, `Engine`, and `Journal` mean here
exactly what they mean in [`@smthrs/flow`](https://flow.smithers.sh/reference/api/),
[`@smthrs/engine`](https://engine.smithers.sh/reference/api/), and [`@smthrs/journal`](https://journal.smithers.sh/reference/api/), and each
package's own site is where their behavior is documented.

**It owns two modules.** `@smthrs/flows/NodeRuntime` and
`@smthrs/flows/SandboxedFlow` exist only here, because both are compositions
across many of the re-exported packages and belong to none of them. They are
Node-only subpaths, kept off the browser-safe root on purpose.

## Install

```bash
pnpm add @smthrs/flows@next
```

For import forms, the Node requirement, and what a composition still has to
choose, see [Installation](/installation/).

## The smallest real program

`NodeRuntime.layerHost` is a whole durable engine host from one call: SQLite
storage, migrations, the guarded Node host, the step boundary, the workspace
sandbox, and signal handling.

```ts
import { Action, Flow, Interpreter } from "@smthrs/flows"
import * as NodeRuntime from "@smthrs/flows/NodeRuntime"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"

const Greet = Action.make("app/Greet", {
  payload: { name: Schema.String },
  success: Schema.String
})

const Greeting = Flow.make("app/Greeting", {
  payload: { name: Schema.String },
  success: Schema.String,
  body: (payload) => Greet.call(payload)
})

const flows = Interpreter.layer(Greeting).pipe(
  Layer.provideMerge(Greet.toLayer(({ name }) => Effect.succeed(`hello, ${name}`))),
  Layer.provideMerge(Action.layerImplementations)
)

const program = Greeting.execute({ name: "Ada" }, { executionId: "greeting-1" }).pipe(
  Effect.provide(
    NodeRuntime.layerHost(
      { filename: ".flows/engine.db", workspaceRoot: ".", owner: { hostId: "local-worker" } },
      flows
    )
  ),
  Effect.scoped
)
```

Run that twice over the same file and the second run answers from the journal
instead of calling `Greet` again. The [Quickstart](/quickstart/) builds the
same program step by step, adds the capability rule a host-reading action needs,
and shows the recorded result on the second run.

## What the barrel re-exports

The authoring model is re-exported flat, because writing a flow is the point of
the library and `Flows.Flow.Flow.make` would be noise. Everything else is a
namespace, so each package keeps its own `make` and `layerNoop` instead of
collapsing them into a shared one: `Kernel.ChildProcessSpawner.layerNoop` and
`RunStore.RunStore.layer` still read as themselves.

| Exported as                                                                                                                                                                        | Package                                       | What it is                                                                         |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- | ---------------------------------------------------------------------------------- |
| `Action`, `DurableClock`, `DurableDeferred`, `DurableQueue`, `Flow`, `FlowRuntime`, `Graph`, `HumanTask`, `Interpreter`, `Poll`, `RetryPolicy`, `Sleep`, `StepIdentity`, `WaitFor` | [`@smthrs/flow`](https://flow.smithers.sh/reference/api/)                   | The authoring model, re-exported flat.                                             |
| `TimeTravel`                                                                                                                                                                       | [`@smthrs/time-travel`](https://time-travel.smithers.sh/reference/api/)     | A service key, re-exported flat: `yield* TimeTravel` is the whole onboarding.      |
| `Engine`                                                                                                                                                                           | [`@smthrs/engine`](https://engine.smithers.sh/reference/api/)               | The engine that executes a plan.                                                   |
| `EngineStore`                                                                                                                                                                      | [`@smthrs/engine-store`](https://engine-store.smithers.sh/reference/api/)   | The durable engine over SQL storage, the step boundary, and the workspace sandbox. |
| `Journal`                                                                                                                                                                          | [`@smthrs/journal`](https://journal.smithers.sh/reference/api/)             | The append-only event record a run replays from, and its redaction rules.          |
| `Plan`                                                                                                                                                                             | [`@smthrs/plan`](https://plan.smithers.sh/reference/api/)                   | Step identity, graph compilation, declared effects, plan storage.                  |
| `RunStore`                                                                                                                                                                         | [`@smthrs/run-store`](https://run-store.smithers.sh/reference/api/)         | Run rows, attempts, and the ownership claims a resume depends on.                  |
| `StepCache`                                                                                                                                                                        | [`@smthrs/step-cache`](https://step-cache.smithers.sh/reference/api/)       | The cache a sealed step's result is eligible for.                                  |
| `Kernel`                                                                                                                                                                           | [`@smthrs/kernel`](https://kernel.smithers.sh/reference/api/)               | The host contracts an action reaches the world through.                            |
| `Capability`                                                                                                                                                                       | [`@smthrs/capability`](https://capability.smithers.sh/reference/api/)       | Capability patterns, permission rules, and the grant decision.                     |
| `Sandbox`                                                                                                                                                                          | [`@smthrs/sandbox`](https://sandbox.smithers.sh/reference/api/)             | Providers and sessions: the machines a body's side effects run on.                 |
| `Artifacts`                                                                                                                                                                        | [`@smthrs/artifacts`](https://artifacts.smithers.sh/reference/api/)         | Content-addressed blob storage for large step values.                              |
| `Database`                                                                                                                                                                         | [`@smthrs/database`](https://database.smithers.sh/reference/api/)           | The SQL client seam and the durable writer over it.                                |
| `Jj`                                                                                                                                                                               | [`@smthrs/jj`](https://jj.smithers.sh/reference/api/)                       | The Jujutsu service the engine takes compensable snapshots through.                |
| `Crypto`                                                                                                                                                                           | [`@smthrs/crypto`](https://crypto.smithers.sh/reference/api/)               | The digest and random seam every derived identity is built on.                     |
| `Canonical`                                                                                                                                                                        | [`@smthrs/canonical`](https://canonical.smithers.sh/reference/api/)         | Canonical JSON, so two hosts digest one value the same way.                        |
| `Keys`                                                                                                                                                                             | [`@smthrs/keys`](https://keys.smithers.sh/reference/api/)                   | Key material and signing.                                                          |
| `Observability`                                                                                                                                                                    | [`@smthrs/observability`](https://observability.smithers.sh/reference/api/) | Tracing and metrics for a run.                                                     |
| `Sync`                                                                                                                                                                             | [`@smthrs/sync`](https://sync.smithers.sh/reference/api/)                   | Run catalogs, workspace sharing, and the sync server.                              |

`namespaces` is the barrel's one runtime value: the sorted list of the names
above, pinned by a test against the packages on disk so a new engine package
cannot join the repository without joining this list.

Why the `@smthrs/platform-*` bundles are absent, and why the root bundles for a
browser without making a browser a durable host, is on
[The aggregate surface](/concepts/aggregate-surface/).

## The two modules of its own

| Module                        | What it does                                                                                                                                                       |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `@smthrs/flows/NodeRuntime`   | Stands a durable engine up on Node and local SQLite. `layerHost` is the batteries-included host; `layer`, `make`, and `storage` are the narrower seams beneath it. |
| `@smthrs/flows/SandboxedFlow` | Runs a child flow's OWN CODE inside a machine a `Sandbox.Provider` supplies, and hands the parent one durable action for the whole thing.                          |

Both are Node-only. `NodeRuntime` opens `node:sqlite`; `SandboxedFlow` bundles
with esbuild and starts a guest runtime.

## Where to go next

- [Installation](/installation/): the Node requirement, the import forms,
  and the platform package you still have to choose.
- [Quickstart](/quickstart/): a durable flow on SQLite, end to end, with the
  capability rule its action needs.
- Guides: [stand up a Node runtime](/guides/stand-up-a-node-runtime/),
  [shut a host down](/guides/shut-a-host-down/),
  [discover flows from a registry](/guides/discover-flows-from-a-registry/),
  [run a child flow in a sandbox](/guides/run-a-child-flow-in-a-sandbox/),
  and [collect the files a sandboxed child wrote](/guides/collect-a-workspace-diff/).
- Concepts: [the aggregate surface](/concepts/aggregate-surface/) and
  [the sandboxed runner protocol](/concepts/runner-protocol/).
- [API reference](/reference/api/): every export of `NodeRuntime` and `SandboxedFlow`,
  with signatures.
- [Troubleshooting](/troubleshooting/): every typed failure these two modules
  raise, what causes it, and what to change.
