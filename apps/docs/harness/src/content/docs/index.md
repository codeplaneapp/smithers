---
title: "@smthrs/harness"
description: "The Smithers built-in agent loop: a cell-first controller whose model turns produce JavaScript cells that run in a persistent realm and reach the world only through durable flow calls."
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/agent/harness/docs/README.md"
---

`@smthrs/harness` is the Smithers built-in agent loop, expressed as pure
translation plus a small set of service ports. One frame of the loop is:

```text
model -> generated cell -> realm evaluation -> individually durable flow calls -> next transition
```

The model emits fenced `cell` blocks of JavaScript. The blocks run as one
program in a realm that outlives the frame, so a name one cell binds is still
bound in the next. The only authority a cell holds is `ctx.call(flowName,
input)`: every effect an agent can reach is a registered flow, and every call
settles through its own keyed, journaled boundary. A cell states its intent by
calling `ctx.done(output)` to complete, `ctx.park(reason, message)` to wait
durably, or neither, which continues the run.

The package holds no scheduler, no database, no transport, and no provider
client. `EngineLike` is the port a durable engine answers, `Sandbox` is the
port a script realm answers, `Steering.Source` is the port a notification
queue answers, and the QuickJS-WASM binding ships behind its own subpath. The
assembled production composition over the durable engine lives in
[`@smthrs/agent`](https://agent.smithers.sh/reference/api/).

## Who uses this package

- **Hosts composing an agent runtime.** `CellTurn` is the controller: it
  decides continue, park, or finish from the transition a cell settled and the
  run's budgets, and streams every decision as journaled `AgentEvent`s. For
  the assembled composition, see [`@smthrs/agent`](https://agent.smithers.sh/reference/api/).
- **Engine authors.** Implementing `EngineLike` connects the controller to a
  durable engine: sealed model steps, durable flow calls, journaled records,
  workspace observation, checkpoints, and suspension.
- **Hosts embedding cells.** `QuickJSSandbox` runs the same single-file
  QuickJS build on Node and in a browser, and names a build on runtimes that
  forbid compiling WebAssembly from bytes, such as Cloudflare's workerd.

## Install

```bash
pnpm add @smthrs/harness@next
```

The package publishes release candidates to the `next` dist-tag. For
requirements and the full entry-point table, see
[Installation](/installation/).

## A working example in one screen

This program opens a QuickJS realm, evaluates one cell that completes the run,
and prints the outcome. It runs on Node with no other setup.

```ts
import * as Cell from "@smthrs/harness/Cell"
import * as QuickJSSandbox from "@smthrs/harness/QuickJSSandbox"
import * as Sandbox from "@smthrs/harness/Sandbox"
import { Effect } from "effect"

const call: Sandbox.Handler = () => Effect.succeed(new Cell.CallResult({ outcome: "success", value: null }))

const program = Effect.gen(function*() {
  const sandbox = yield* QuickJSSandbox.make
  const realm = yield* sandbox.openRealm!({ flows: {} })
  const frame = yield* realm.evaluate({
    cell: Cell.source(`ctx.done("hello from the realm")`),
    frame: 0,
    call
  })
  return frame.outcome
})

const outcome = await Effect.runPromise(Effect.scoped(program))
console.log(outcome)
// { _tag: "settled", transition: { _tag: "complete", output: "hello from the realm" } }
```

For a guided version that adds flow calls, prints, and realm persistence, see
the [Quickstart](/quickstart/).

## Where to go next

- [Installation](/installation/): requirements, entry points, and the
  companion `effect` version.
- [Quickstart](/quickstart/): run two cells against one realm and read the
  frames they produce.
- [Run cells in a persistent realm](/guides/run-cells/): the `Sandbox`
  port, the QuickJS binding, limits, prints, and checkpoints.
- [Expose flows to cells](/guides/bind-flows/): pair flow declarations
  with handlers through `FlowBinding`, and resolve calls with `CellCalls`.
- [Drive the cell loop](/guides/drive-the-loop/): `CellTurn.run`, the
  `EngineLike` implementation it needs, and the events it streams.
- [Run on Cloudflare workerd](/guides/workerd/): name the QuickJS build a
  worker can instantiate.
- [Concepts](/concepts/): the cell loop, the persistent realm, durable
  flow calls as the only I/O, and the designs the source cites.
- [API reference](/reference/api/): behavior and signatures for every public export.
- [Module and export inventory](/reference/): every module and its
  exports, one table per module.
- [Troubleshooting](/troubleshooting/): the failure modes the package
  raises, and what to do about each.
- [Development history](/history/): the wave-by-wave record of why each
  control exists.
