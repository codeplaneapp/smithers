---
title: "Run a flow as a child execution"
description: "Choose between splicing a callee inline, opening a real child execution, and handing off to the next round, and know which build refusals force a boundary."
sidebar:
  order: 8
---

A flow can reach another flow in three ways, and they are three different things.

| Call                    | What the caller's plan holds                                                             | Requirements             | Identity                                                                              |
| ----------------------- | ---------------------------------------------------------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------- |
| `callee.call(payload)`  | The callee's whole body, spliced in. Every inner step is visible and individually keyed. | Propagate to the caller. | The caller's execution.                                                               |
| `callee.child(payload)` | One leaf.                                                                                | Dropped.                 | A separate execution, with its own row, journal lineage, retry policy, and placement. |
| `callee.to(payload)`    | The settlement of this round.                                                            | Dropped.                 | The next round of this trampoline lineage.                                            |

## Splice a callee inline

```ts
import { Action, Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import * as Schema from "effect/Schema"

const Build = Action.make("release/Build", {
  payload: { target: Schema.String },
  success: Schema.String
})

export const Compile = Flow.make("release/Compile", {
  payload: { target: Schema.String },
  success: Schema.String,
  body: (payload) => Build.call(payload)
})

export const Release = Flow.make("release/Release", {
  payload: { target: Schema.String },
  success: Schema.String,
  body: ({ target }) => Compile.call({ target })
})
```

Inline is the default choice. One plan, one run, and every step of the callee is
a node the caller's operator can see, key, and replay. The callee's obligations
become the caller's, which is exactly right: they are running in the caller's
execution.

## Open a real child

```ts
export const Fanout = Flow.make("release/Fanout", {
  payload: { targets: Schema.Array(Schema.String) },
  success: Schema.Struct({ web: Schema.String, api: Schema.String }),
  body: () =>
    Node.all({
      web: Compile.child({ target: "web" }),
      api: Compile.child({ target: "api" })
    })
})
```

Choose `child` when the callee should be its own unit of work: its own run row to
watch, its own journal lineage, its own retry and placement decisions. The
parent's plan holds one leaf naming it, the parent suspends while the child is
unsettled, and it resumes when the child settles.

The identity is derived rather than minted. `Interpreter.childExecutionId`
combines the parent execution id, the node's address, the callee tag, and a digest
of the payload, so a re-driven parent lands on the child it already started
instead of opening a second one. That is what makes a child at most once without
the caller naming an id.

Requirements are dropped at the boundary because the child runs under its own
driver, which provides its own context. The caller's composition does not have to
carry the child's implementations, and the child's driver does.

## Hand off to the next round

`callee.to(payload)` ends the current round and names the next one. It is the
loop construct, not a call: nothing comes back, because this execution is over.
See [Trampoline rounds](../concepts/trampoline-rounds.md).

## When a boundary is required

Two build refusals exist to send you to `child` or `to`, and both throw from
`Graph.build` rather than landing in diagnostics:

- `recursion_requires_boundary`: a flow called itself inline. Inline expansion
  would never terminate. Use `to` for a loop or `child` for a nested run.
- `placement_requires_boundary`: an inline callee declares a `Flow.Placement`
  the enclosing flow cannot satisfy. A placement is a property of an execution,
  so a callee that needs a different one needs its own execution.

At run time, `FlowRuntime.FlowCycleDetected` is the separate refusal for a child
whose execution would close a cycle in the persisted parent chain. Its `path`
holds the ordered execution ids from the cycle's target back to itself.

## Cancellation and cleanup travel

A parent's interruption reaches its children, and a child's suspension reaches
its parent, because the engine records the lineage edge. Cleanup follows the
same edges: see
[Cancel a run and undo its effects](./cancel-and-roll-back.md).

## Related pages

- [Flows and actions](../concepts/flows-and-actions.md): the propagation rules,
  stated once.
- [Execution identity](../concepts/execution-identity.md): how a child's id is
  derived.
