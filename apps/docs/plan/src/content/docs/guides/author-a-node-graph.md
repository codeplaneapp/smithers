---
title: "Author a node graph"
description: "Build topology with the Node combinators, pass step results as planned values, and turn the result into the drafts Plan.compile takes."
sidebar:
  order: 1
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/plan/docs/guides/author-a-node-graph.md"
---

`Node` is the authoring AST: pure, pipeable values that describe what a run will
do. This guide builds a graph with it and turns that graph into
`Plan.NodeDraft` values.

Most flow authors reach this layer through [`@smthrs/flow`](https://flow.smithers.sh/reference/api/), which
walks a flow body for you. Reach for `Node` directly when you are writing that
walk, testing topology, or composing a graph outside a flow declaration.

## Start from a value

`Node.succeed` lifts a constant. Nothing runs:

```ts
import * as Node from "@smthrs/plan/Node"

const lint = Node.succeed("lint")
```

## Transform with map

`Node.map` defers a pure function. It is digested at build time and applied to
the real value later:

```ts
const shouted = Node.map(Node.succeed({ name: "world" }), (value) => value.name.toUpperCase())
```

Use `map` for computation only. A `map` that chooses what happens next is a
`branch` written wrongly, and the plan loses the topology a reviewer needs to
see.

## Sequence with andThen

`Node.andThen` puts one node after another. Supply a node directly when the
first result is not needed, or a builder when it is. A builder is evaluated once
at build time against a `Planned` placeholder:

```ts
import { Action } from "@smthrs/flow"
import type * as Planned from "@smthrs/plan/Planned"
import * as Schema from "effect/Schema"

const Draft = Action.make("docs/Draft", {
  payload: { topic: Schema.String },
  success: Schema.String,
  error: Schema.String
})

const Publish = Action.make("docs/Publish", {
  payload: { text: Schema.String, urgent: Schema.Boolean },
  success: Schema.String
})

const article = Node.andThen(
  Draft.call({ topic: "durable plans" }),
  (text: Planned.Planned<string>) => Publish.call({ text, urgent: false })
)
```

`text` is a placeholder, not a string. Pass it into a payload field, read a
field off it, hand it to a branch: all of that records a reference. Computing on
it throws `planned_value_computed` with the node and path named. [The authoring AST](/concepts/authoring-ast/) covers the rule and why it fails twice.

## Decide with branch

Both arms are built once, symbolically, so the plan carries the exit condition
and both continuations before anything runs:

```ts
const decided = Node.andThen(
  Draft.call({ topic: "durable plans" }),
  (text: Planned.Planned<string>) =>
    Node.branch(Node.succeed({ urgent: true }), {
      if: (flags) => flags.urgent,
      then: () => Publish.call({ text, urgent: true }),
      else: () => Publish.call({ text, urgent: false })
    })
)
```

`if` runs later, on the real value. `then` and `else` run now, once each.

## Recover with catch

`Node.catch` stores the failure arm as topology beside the protected graph.
Without an `error` schema it handles the whole typed error channel; with one it
handles only the values that schema accepts, and the rest survives in the
resulting error type:

```ts
const recovered = Node.catch(Draft.call({ topic: "fallbacks" }), {
  onFailure: () => Node.succeed("draft unavailable")
})
```

## Fan out with all

`Node.all` combines independent children by name. Its width is fixed here, at
build time:

```ts
const batched = Node.all({
  lint: Node.priority(Node.succeed("lint"), 10),
  types: Node.succeed("types")
})
```

To fan out over something a step discovered, end the round and carry the list in
the next flow's payload, where it is real data. A plan is a DAG and cannot grow
a leg it did not declare.

## Prioritize without re-keying

`Node.priority` attaches a scheduling priority and leaves the original node
unchanged. Higher runs first among ready work, so a priority changes latency and
nothing else. It never enters key material, so a prioritized node keeps its
cache hit. Children inherit the value lexically when the graph is built, and a
child that states its own keeps it.

`Node.declaredPriority(ast)` reads back the value a node states, or `undefined`
when it inherits.

`Node.priority` refuses anything that is not a safe integer with
`invalid_priority`, because no ordering could compare it.

## Declare captures for a deterministic digest

The AST stores a digest of a function's exact source, never the closure. A
function with undeclared captures also carries process-local entropy, so two
indistinguishable sources fail closed rather than sharing a cache key. Declare
the inert values a function closes over to get a deterministic identity instead:

```ts
const suffixed = Node.capture({ suffix: "!" }, (value: string) => `${value}!`)
```

## Turn the graph into drafts

`Plan.compile` takes `NodeDraft` values, and [`@smthrs/flow`](https://flow.smithers.sh/reference/api/) is what
produces them. `Graph.build` walks a flow declaration or a bare node once;
`Graph.drafts` reads the drafts back:

```ts
import { Flow, Graph } from "@smthrs/flow"
import * as Plan from "@smthrs/plan/Plan"

const Article = Flow.make("docs/Article", {
  payload: { topic: Schema.String },
  success: Schema.String,
  error: Schema.String,
  body: ({ topic }: { readonly topic: string }) =>
    Node.andThen(Draft.call({ topic }), (text: Planned.Planned<string>) => Publish.call({ text, urgent: false }))
})

const drafts: ReadonlyArray<Plan.NodeDraft> = Graph.drafts(Graph.build(Article, { topic: "plans" }))
```

`Graph.drafts` throws the first typed build refusal rather than returning
partial drafts, because returning them would turn missing topology into a valid
plan. `Graph.diagnostics` lists the recoverable issues a build recorded; fatal
refusals, including computing on a planned value, throw from `Graph.build`
itself.

## Next

- [Compile drafts into a plan](/guides/compile-a-plan/): keys, ordering, conflict
  annotation, and the digest.
- [The authoring AST](/concepts/authoring-ast/): why building runs nothing,
  and how a closure survives as a digest.
