---
title: "@smthrs/harness"
description: "An agent loop where the model writes JavaScript instead of calling tools: each turn runs as one program in a sandbox that outlives it, and reaches the world only through durable flow calls."
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/agent/harness/docs/README.md"
---

`@smthrs/harness` runs an agent loop in which the model writes JavaScript
instead of calling tools. Each turn the model emits a **cell**: a small
program that runs in a sandbox the run keeps open, and that reaches the
outside world through exactly one function, `ctx.call(flowName, input)`.

A **flow** is the unit `ctx.call` names: a declaration that states what the
call takes, what it returns, and what it is allowed to touch, paired with the
code that runs it. Every capability an agent reaches is one of these, so a
cell reaches a file read, an MCP tool, and a subagent with the same two lines.
[`@smthrs/core`](https://core.smithers.sh/reference/api/) is where flow declarations come from.

The package is written with [Effect](https://effect.website): the functions
below return `Effect` values, and you run them with `Effect.runPromise` or
compose them into a larger program.

## Why you would reach for it

A tool-calling agent spends a model turn per tool call and carries nothing
between calls except what it wrote back into the transcript. A cell does a
whole step of work in one turn: search, branch on what the search found, read
the region that matters, edit it, run the check again, all as ordinary
JavaScript with real control flow. The sandbox outlives the turn, so a name
one cell binds is still bound in the next, and what a cell prints is what the
next model turn reads.

Handing a model a script engine usually costs you durability. It does not
here. Every `ctx.call` is its own keyed, journaled, permission-gated boundary,
so a cell is never one opaque activity: a crash or an approval pause in the
middle of a cell re-executes the cell from the top, replays the calls that
already settled, and arrives back at the one that stopped. A cell says how the
run should proceed by calling `ctx.done(output)` to finish,
`ctx.park(reason, message)` to wait durably, or neither, which continues to the
next turn.

One frame of the loop is:

```text
model -> generated cell -> realm evaluation -> individually durable flow calls -> next transition
```

## How this fits with @smthrs/agent

`@smthrs/harness` is the loop and the contracts around it, and nothing else.
It holds no scheduler, no database, no transport, and no model client; those
arrive through ports. `EngineLike` is the port a durable engine answers,
`Sandbox` is the port a script realm answers, and `Steering.Source` is the port
a notification queue answers.

[`@smthrs/agent`](https://agent.smithers.sh/reference/api/) is the package that fills those ports in. It
composes this loop over the durable Smithers engine and publishes it as one
service you can run, plus adapters that run it as a control-plane session or as
a typed step inside a larger flow. If you want to run an agent, start there and
come back here for the contracts underneath it.

Reach for `@smthrs/harness` directly when you are building the host yourself:
your own durable engine behind `EngineLike`, your own script realm behind
`Sandbox`, or a cell runner embedded in something that is not a Smithers run.
The QuickJS binding at `@smthrs/harness/QuickJSSandbox` is usable on its own,
on Node, in a browser, and on Cloudflare workerd.

Both packages sit under [`@smthrs/cli`](https://cli.smithers.sh/reference/api/), the `smithers` command-line
tool, which runs, watches, and steers agents without your writing a host at
all.

## Get the package

`@smthrs/harness` is not on npm at 1.0.0-rc.0. Its source lives in the
[smithers repository](https://github.com/smithersai/smithers), and
[Installation](/installation/) covers how to depend on it from a checkout,
the runtimes it supports, and the `effect` version it pins.

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
  flow calls as the only I/O, and the design each module enforces.
- [API reference](/reference/api/): behavior and signatures for every public export.
- [Module and export inventory](/reference/): every module and its
  exports, one table per module.
- [Troubleshooting](/troubleshooting/): the failure modes the package
  raises, and what to do about each.
