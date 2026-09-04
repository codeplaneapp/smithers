---
title: "Run a child flow in a sandbox"
description: "Put a child flow's own code on a provisioned machine with SandboxedFlow: write the entry module, call execute directly, or declare the whole execution as one durable action of a parent flow."
sidebar:
  order: 4
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/docs/guides/run-a-child-flow-in-a-sandbox.md"
---

`@smthrs/flows/SandboxedFlow` runs a child flow's own code inside a machine a
`Sandbox.Provider` provisions. The child's TypeScript never runs in the parent's
process. Read
[the sandboxed runner protocol](/concepts/runner-protocol/) for what happens
on the wire; this guide is the wiring.

## Write the entry module

The entry is the module that gets bundled. It exports the flow, and, when the
flow's body names actions, a `layer` that implements them. Everything the
implementation touches belongs to the guest: `process.cwd()` is the session
workdir, and files it writes land in the workspace the host can read back.

```ts
// child.ts
import { Action, Flow } from "@smthrs/flow"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { writeFile } from "node:fs/promises"

export const Greeting = Schema.Struct({ greeting: Schema.String, workdir: Schema.String })

export const ComposeGreeting = Action.make("app/ComposeGreeting", {
  payload: { name: Schema.String },
  success: Greeting
})

export const Greet = Flow.make("app/Greet", {
  payload: { name: Schema.String },
  success: Greeting,
  body: (payload) => ComposeGreeting.call(payload)
})

/** The implementations the guest runner provides beside the interpreter. */
export const layer = ComposeGreeting.toLayer(({ name }) =>
  Effect.promise(async () => {
    const greeting = `hello, ${name}`
    await writeFile("greeting.txt", greeting)
    return { greeting, workdir: process.cwd() }
  })
)
```

The flow may be exported under any name, including as the default export. The
runner finds it by tag.

## Run it directly

`execute` acquires the session, runs the protocol, and releases the session
when it returns. A normal completion tears the machine down.

```ts
import * as SandboxedFlow from "@smthrs/flows/SandboxedFlow"
import * as Effect from "effect/Effect"

const greet = Effect.gen(function*() {
  const result = yield* SandboxedFlow.execute(Greet, { name: "Ada" }, {
    provider,
    session: "greet-1",
    entry: new URL("./child.ts", import.meta.url)
  })
  // result.output is Greet's success value, decoded through Greet's own schema.
  return result.output
})
```

`entry` is a `file:` URL or an absolute path. `provider` is a
`Sandbox.Provider` value that you pass in: there is no string registry, no
lookup by name, and no environment variable default.

The remaining options are all optional:

| Option        | Default                       | What it does                                                                                                                                                       |
| ------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `runtime`     | `"node"`                      | The guest command the bundle is started with. `"bun"` and any command line the guest shell resolves also work; the bundle path is appended, quoted.                |
| `collectDiff` | `false`                       | Read back the files the guest created or resized. See [Collect the files a sandboxed child wrote](/guides/collect-a-workspace-diff/).                                  |
| `limits`      | `SandboxedFlow.defaultLimits` | Bounds on the result and the diff.                                                                                                                                 |
| `timeout`     | 10 minutes                    | The wall-clock budget for the whole session, acquisition through result readback. It is measured on the platform timer, so it fires under a frozen test clock too. |

## Make it one durable action of a parent

This is the usual shape. `action(flow)` declares an ordinary durable action over
the child's payload schema, and `toLayer` implements it with `execute`. The
parent's body calls it like any other action.

```ts
import { Action, Flow, Interpreter } from "@smthrs/flows"
import * as SandboxedFlow from "@smthrs/flows/SandboxedFlow"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import { Greet, Greeting } from "./child.ts"

const RunGreet = SandboxedFlow.action(Greet)

const SandboxedGreeting = Flow.make("app/SandboxedGreeting", {
  payload: { name: Schema.String },
  success: SandboxedFlow.resultSchema(Greeting),
  error: SandboxedFlow.SandboxedFlowError,
  body: (payload) => RunGreet.call(payload)
})

const stack = Layer.mergeAll(
  SandboxedFlow.toLayer(RunGreet, Greet, ({ executionId }) => ({
    provider,
    session: `greet:${executionId}`,
    entry: new URL("./child.ts", import.meta.url)
  })),
  Interpreter.layer(SandboxedGreeting)
).pipe(Layer.provideMerge(Action.layerImplementations))
```

The action's tag is `app/Greet/sandboxed` unless you pass
`{ name: "..." }` as `action`'s second argument. Its success schema is
`resultSchema(Greeting)`, which is `{ output, diff }`, and its error schema is
`SandboxedFlowError`.

Compose the returned layer beside `Interpreter.layer(parent)` over one
`Action.layerImplementations`, exactly as you would any other action
implementation.

## Derive the session key from the execution

`toLayer`'s third argument is either the placement itself or a function of the
call's context, which carries the decoded payload and the parent's
`executionId`. Deriving the key from `executionId`, as above, is the recommended
shape: the claim is exclusive per execution and stable across a resume, because
a crash that left a machine behind is reattached by the next execution with the
same key.

Because the whole sandboxed execution is one durable action, a second run of the
parent over the same database answers from the journal and never asks the
provider for a machine at all.

## Choose a provider

Providers come from [`@smthrs/sandbox`](https://sandbox.smithers.sh/reference/api/), which ships several,
including `DirectorySandbox` for a local scratch directory. Any value with an
`acquire` method satisfies `Sandbox.Provider`, so wrapping one to count
acquisitions or inject a fault is a few lines:

```ts
import type { Sandbox } from "@smthrs/sandbox"

let acquisitions = 0
const counted: Sandbox.Provider = {
  acquire: (session) => {
    acquisitions++
    return underlying.acquire(session)
  }
}
```

## Check the guest image

The runtime the bundle is started with has to be on the guest's `PATH`, and
nothing installs it. `node:22-alpine` has `node`; bare `alpine` does not, and a
missing runtime comes back as `guest_failed` naming what it looked for. The full
list of refusals is in [Troubleshooting](/troubleshooting/).
