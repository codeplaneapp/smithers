---
title: "Plan time"
description: "Why every value in this package is inert, what Graph.build actually evaluates, and the rules that come with planning a body against a symbolic placeholder."
sidebar:
  order: 1
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/core/docs/concepts/plan-time.md"
---

Two things happen to a flow. At plan time, a declaration is read and turned
into a graph. At run time, a host executes what that graph describes. This
package owns the first half only, and the separation is not stylistic: a
durable engine cannot cache, resume, schedule, or place work it has not been
told about in advance.

## Everything here is inert

`Flow.make` builds a value. Calling that value builds another value. `Node.map`
and `Node.andThen` store the functions you hand them without calling them.
Nothing in this package opens a file, starts a process, calls a model, resolves
a registry name, or runs an Effect. That is what makes the model safe to hand
untrusted structure: an agent that emits a declaration has emitted data, not
behavior.

The exception is deliberate and named. `TestRuntime` does execute the deferred
callbacks a node stores, because a library that builds nodes has to test what
it built. It is a test helper with no capabilities, no persistence, and no
scheduling. See
[Test a declaration without a host](/guides/test-a-declaration/).

## What Graph.build evaluates

`Graph.build` walks the declaration once. Along the way it evaluates exactly
two kinds of function, exactly once each:

- Every flow body it enters, against that call's input.
- Every `Node.andThen` builder and every `Node.catch` recovery arm, against a
  symbolic placeholder standing for the value the arm will receive.

It does not evaluate a `Node.map` mapper, does not elaborate a dynamic node,
and does not run anything the host owns. Evaluating the builders is what makes
the downstream topology visible: the plan contains the report step and its
dependency on the review step before either has run.

The result is frozen. `Graph.nodes`, `Graph.edges`, `Graph.conflicts`, and
`Graph.diagnostics` hand back the graph's own values, so a reader cannot edit
the plan it is reading.

## Node ids are structural

A node's id is its position in the declaration: `root`, `root.andThen`,
`root.andThen.all.api`, `root.then`. The id is traversal data, not identity;
it never reaches the hash that produces a step key. Two consequences follow.

The ids are stable across processes, so a diagnostic naming
`root.andThen.all.api` names the same place in your source every time. And
renaming a flow, or moving it inside a lane, does not change what a step keys
on, because the name and the tree position were never part of the key.

## Edges say why

Every edge carries a `reason`, and the four values are distinct kinds of
ordering:

| Reason         | What it means                                                          |
| -------------- | ---------------------------------------------------------------------- |
| `value`        | A structural dependency: the target consumes the source's value.       |
| `continuation` | A statically planned `andThen` or `catch` arm follows the source.      |
| `conflict`     | The write-conflict pass ordered two writers that would otherwise race. |
| `lane-merge`   | Two laned writers join at the merge node this package synthesized.     |

A scheduler reading only `value` edges sees the data flow. A scheduler that
honors `conflict` edges too gets the serialization the effect declarations
asked for, without either declaration knowing the other exists.

## The placeholder is a name, not a value

The value handed to an `andThen` builder or a `catch` arm is a symbolic
placeholder. It is typed as the success type so member access reads naturally,
and reading a member is the intended use: it records an input reference naming
the node and the path.

```ts
Node.andThen(reviews, (result) => Report({ notes: result.api.notes }))
```

That records `{ _tag: "Ref", from: "root.andThen", path: ["api", "notes"] }`.
The dependency is now a fact in the plan.

Computing on the placeholder is not the intended use, and the failure mode is
quiet:

- Arithmetic and string interpolation coerce it to the literal text
  `[planned:<path>]`. A body that writes `` `report: ${result.api.notes}` ``
  bakes the string `report: [planned:api.notes]` into the plan's identity.
- A conditional on it always takes the truthy branch, because the placeholder
  is an object. Only that branch gets planned.
- Neither produces a diagnostic. The plan is well formed; it just says
  something you did not mean.

The rule that follows is short: read members from the placeholder to name what
a later step consumes, and decide with real values inside the step that
produces them.

## The reserved `then` member

Reading `then` on a placeholder yields `undefined`, always. Without that, an
`async` boundary anywhere above the plan would see a thenable and try to await
the placeholder. A declaration with a legitimate `then` field has to rename it,
or read it inside the step that produces it.

## Plan values are read by reference

`Node.succeed`, `Node.fail`, and a flow call retain the value you pass by
reference and read it when `Graph.build` runs, not when you construct the node.
Mutating a value between those two moments changes the recorded identity. If
that matters for your code, pass a value nothing else holds a handle to.

## Failures split two ways, on purpose

Construction failures throw, because they mean the declaration is malformed and
there is nothing to inspect: `Flow.make` and a flow call raise `FlowError`,
`Node.all` and `Node.priority` and continuation elaboration raise
`NodeBuildError`, and `Node.capture` raises a `TypeError`.

Declaration failures are recorded. `Graph.build` returns a graph even when the
declaration is invalid and lists the problems in `Graph.diagnostics`, so a
reviewer can see the whole plan and its objections at once.
`Graph.keyMaterial` is where the two meet: it refuses a graph carrying a fatal
diagnostic, returning that diagnostic unchanged, so a declaration the builder
called invalid can never become a durable step key. `Graph.isFatalDiagnostic`
reports which codes block it.

For each code and its fix, see [Troubleshooting](/troubleshooting/).

## Where to go next

- [Identity and key material](/concepts/identity/): what makes two declarations the
  same step.
- [Inspect a built graph](/guides/inspect-a-graph/): the getters and what
  each one answers.
