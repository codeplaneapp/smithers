---
title: "Quickstart"
description: "Declare two flows, plan them into a graph, read the topology and key material back, and evaluate the same declaration in memory. No host, no engine, no model."
sidebar:
  order: 2
---

This quickstart builds one plan end to end. Nothing executes: you declare two
flows, compose them, and read back the topology, the dependency references, and
the key material a durable engine would key its steps on. Everything runs in
one process with no engine, no model, and no file system.

## Prerequisites

- Node.js 22.19.0 or later.
- A package with the dependency installed:

```bash
pnpm add @smthrs/core@next
```

## Declare two flows

Create `quickstart.ts`. A flow is a declaration: input schema, output schema,
and a body that returns a node. The body is a plain function, and this package
never calls it for its value.

```ts
import { Flow, Graph, Node, TestRuntime } from "@smthrs/core"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"

const Review = Flow.make({
  name: "review",
  input: Schema.Struct({ path: Schema.String }),
  output: Schema.Struct({ approved: Schema.Boolean, notes: Schema.String }),
  body: ({ path }) => Node.succeed({ approved: true, notes: `reviewed ${path}` })
})

const Report = Flow.make({
  name: "report",
  input: Schema.Struct({ notes: Schema.String }),
  output: Schema.Struct({ published: Schema.Boolean, notes: Schema.String }),
  body: ({ notes }) => Node.succeed({ published: true, notes })
})
```

Calling `Review({ path: "src/api.ts" })` does not run the body. It returns a
node that records the call.

## Compose them into a plan

`Node.all` runs two independent calls as one join. `Node.andThen` sequences a
builder after it, and the builder receives a symbolic placeholder standing for
the join's eventual value:

```ts
const plan = Node.all({
  api: Review({ path: "src/api.ts" }),
  cli: Review({ path: "src/cli.ts" })
}).pipe(
  Node.andThen((reviews) => Report({ notes: reviews.api.notes }))
)
```

`reviews` is not the reviews. It is a placeholder whose member reads are
recorded, so `reviews.api.notes` says "this step reads the `notes` field of the
`api` member". Read members from it; never compute on it. See
[Plan time](./concepts/plan-time.md) for what happens when you do.

## Plan the graph

`Graph.build` walks the declaration once, evaluating each flow body and each
`andThen` builder exactly once against those placeholders:

```ts
const graph = Graph.build(plan)

for (const node of Graph.nodes(graph)) {
  console.log(`${node.id} (${node.kind})`)
}
```

```text
root (AndThen)
root.andThen (All)
root.andThen.all.api (FlowCall)
root.andThen.all.api.flow (Succeed)
root.andThen.all.cli (FlowCall)
root.andThen.all.cli.flow (Succeed)
root.then (FlowCall)
root.then.flow (Succeed)
```

Node ids are structural: a node's id is its position in the declaration, so the
same declaration always produces the same ids. A `FlowCall` node and the
`.flow` node under it are the call and the body it entered.

## Read the edges

```ts
for (const edge of Graph.edges(graph)) {
  console.log(`${edge.from} -> ${edge.to} [${edge.reason}]`)
}
```

```text
root.andThen.all.api.flow -> root.andThen.all.api [value]
root.andThen.all.api -> root.andThen [value]
root.andThen.all.cli.flow -> root.andThen.all.cli [value]
root.andThen.all.cli -> root.andThen [value]
root.andThen -> root.then [continuation]
root.then.flow -> root.then [value]
root.then -> root [value]
```

The two reviews depend on nothing and on each other in no way, so a scheduler
may run them at the same time. The `continuation` edge is the `andThen`: the
report cannot start until the join settles.

## Check for problems, then read the key material

`Graph.build` records declaration problems rather than throwing them, so an
invalid plan stays inspectable. Check `diagnostics` before you trust a graph:

```ts
console.log(Graph.diagnostics(graph).length) // 0

const material = Result.getOrThrow(Graph.keyMaterial(graph))
console.log(material.map((entry) => entry.nodeId))
```

```text
[
  'root.andThen.all.api.flow',
  'root.andThen.all.api',
  'root.andThen.all.cli.flow',
  'root.andThen.all.cli',
  'root.andThen',
  'root.then.flow',
  'root.then',
  'root'
]
```

`keyMaterial` returns a `Result`, and it refuses a graph carrying a fatal
diagnostic rather than handing back a key for a plan the builder called
invalid. The entries arrive in topological dependency order, so a key compiler
can substitute each dependency's digest before it hashes the node that depends
on it.

Look at what the placeholder read became. This is the entry for `root.then`,
the report call:

```ts
console.dir(
  material.find((entry) => entry.nodeId === "root.then")?.material.inputs,
  { depth: null }
)
```

```text
[
  {
    _tag: 'Literal',
    value: [Object: null prototype] {
      notes: { _tag: 'PlannedInput', path: [ 'api', 'notes' ] }
    }
  },
  { _tag: 'Ref', from: 'root.andThen', path: [ 'api', 'notes' ] },
  { _tag: 'Pending', from: 'root.andThen' },
  { _tag: 'Ref', from: 'root.then.flow', path: [] }
]
```

Reading `reviews.api.notes` recorded a `Ref` naming the node it came from and
the path it read. That is the whole point of planning against placeholders: the
dependency is a fact in the plan, not something discovered while the plan runs.

## Evaluate the same declaration

`TestRuntime` runs the deferred callbacks the AST stores, so a test can assert
on value behavior without a host. `evaluateInline` also enters called flows
that carry a body:

```ts
const evaluated = TestRuntime.evaluateInline(plan)
console.log(Result.isSuccess(evaluated) ? evaluated.success : evaluated)
```

```text
{ published: true, notes: 'reviewed src/api.ts' }
```

This is a test helper, not a runtime. It models no capabilities, no
persistence, no scheduling, no retries, and no cache. See
[Test a declaration without a host](./guides/test-a-declaration.md) for what it
is good for and where the boundary sits.

## What just happened

You wrote a declaration and got back a complete plan: eight nodes, seven edges,
one dependency reference, and eight pieces of key material, without executing
a single step. That is the contract this package exists to provide, and it is
what lets the layers above it cache, resume, schedule, and place work.

## Next steps

- [Plan time](./concepts/plan-time.md): what `Graph.build` does, and the
  placeholder rules that come with it.
- [Identity and key material](./concepts/identity.md): what makes two
  declarations the same step.
- [Declare what a step reads and writes](./guides/declare-reads-and-writes.md):
  effect envelopes, narrowing, and write conflicts.
