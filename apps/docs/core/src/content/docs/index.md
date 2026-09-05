---
title: "@smthrs/core"
description: "The plan-time data model for agent flows: inert Flow and Node declarations that build into an inspectable graph of steps, dependencies, effect envelopes, and step-key material, without running anything."
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/core/docs/README.md"
---

`@smthrs/core` describes agent work without running it. You declare a flow, which
is an input schema, an output schema, and a body that composes nodes. Calling
that flow executes nothing: it constructs a value. `Graph.build` turns the value
into a graph you can read, listing the steps, the dependencies between them,
what each step reads and writes, where it should run, and the material that
gives it a stable identity.

Nothing in the package executes. It opens no file, starts no process, calls no
model, and runs no Effect. A declaration is data, which is what makes it safe to
accept one from an agent, store it, diff it, or review it before anyone acts on
it.

## The problem it solves

Multi-step agent work is usually written as behavior: a function calls a model,
writes a file, then decides what to call next. Nothing outside the process knows
the shape of that work until it has already happened, and several useful things
become impossible at once.

- A cache cannot recognize a step it has already run.
- A resumed run cannot tell which steps finished before the crash.
- A scheduler cannot start two independent steps together.
- A reviewer cannot see what a generated plan will touch before it touches it.
- A sandbox cannot be provisioned for a step nobody has described yet.

Each of those needs the same thing: the work described in advance, in a form
that is inspectable and comparable. Building that description is this package's
whole job. Reach for it when something has to read a plan before the plan runs,
whether that something is a durable engine, a policy check, a cost estimate, a
diagram, or a test.

## Install

```bash
pnpm add @smthrs/core
```

The package needs Node.js 22.19.0 or later. It has no platform bindings, so the
same build runs in Node, in Bun, in a browser, and in a Cloudflare Worker.

## Order two steps before either one runs

Two review steps write the same report file. Neither has run, and neither knows
the other exists, but each declares what it writes:

```ts
import { Effects, Graph, Node } from "@smthrs/core"

const report = Effects.make({
  reads: ["src/api.ts", "src/cli.ts"],
  writes: ["out/report.md"],
  mode: "hermetic",
  onConflict: "serialize"
})

const plan = Node.all({
  api: Node.dynamic({ model: "smart", prompt: "Review src/api.ts.", effects: report }),
  cli: Node.dynamic({ model: "smart", prompt: "Review src/cli.ts.", effects: report })
})

const graph = Graph.build(plan)

for (const edge of Graph.edges(graph)) {
  console.log(`${edge.from} -> ${edge.to} [${edge.reason}]`)
}
```

```text
root.all.api -> root [value]
root.all.cli -> root [value]
root.all.api -> root.all.cli [conflict]
```

The two `value` edges are the data flow: the join consumes both results. The
third edge is the one neither step asked for. The declarations overlap on
`out/report.md` and both chose `onConflict: "serialize"`, so the planner ordered
the writers. `Graph.conflicts` reports the same fact with the paths attached:

```ts
console.log(Graph.conflicts(graph))
```

```text
[
  {
    nodes: [ 'root.all.api', 'root.all.cli' ],
    paths: [ 'out/report.md' ],
    strategy: 'serialize'
  }
]
```

A scheduler that honors `conflict` edges gets that serialization for free, and a
reviewer reading the graph sees the overlap before a model is called. Six more
getters answer the rest of the questions about a built graph: `Graph.nodes` and
`Graph.edges` for topology, `Graph.effects` and `Graph.placements` for what each
step touches and where it belongs, `Graph.diagnostics` for the problems the
build recorded instead of throwing, and `Graph.keyMaterial` for the identity of
every step.

## How this fits with @smthrs/flows

`@smthrs/core` says what the work is. [`@smthrs/flows`](https://flows.smithers.sh/reference/api/) is what runs
it: one barrel package over the durable flow engine, including the journal, the
run store, the step cache, the plan store, and sandboxing. The two meet at
`Graph.keyMaterial`. `@smthrs/plan`, one of the packages that barrel re-exports,
compiles each entry into a step key, substituting each dependency's digest for
the graph-local reference recorded here. That key is how a resumed run
recognizes a step it already finished.

The split is a dependency direction rather than a diagram. This package depends
on `effect` and two small hashing packages and nothing else, so a catalog
server, a linter, a browser tab, or a unit test can plan and inspect a
declaration with no database anywhere in the tree. Unlike the engine packages,
`@smthrs/core` is not re-exported by `@smthrs/flows`: install it directly, even
when you already depend on the barrel.

Both sit under the `smithers` command line tool, [`@smthrs/cli`](https://cli.smithers.sh/reference/api/),
which runs, resumes, and inspects flows from a terminal. If you arrived at this
package from a stack trace or a dependency list and want the product rather than
its data model, start there.

## Where to go next

- [Installation](/installation/): runtime requirements, the two import forms,
  what the export map keeps private, and the packages that sit above this one.
- [Quickstart](/quickstart/): declare two flows, plan them, and read back the
  topology, the dependency references, and the key material.
- [Plan time](/concepts/plan-time/): why everything here is inert, what
  `Graph.build` evaluates, and the placeholder rules that come with it.
- [Identity and key material](/concepts/identity/): what makes two
  declarations the same step, and what `Node.capture` fixes.
- [Effect envelopes](/concepts/effects/): how a step declares its reads and
  writes, and what the planner does with two writers of one path.
- [Build limits](/concepts/limits/): the ten exported bounds that keep a
  generated declaration from exhausting the host.
- [Declare a flow](/guides/declare-a-flow/) and
  [Compose nodes into a plan](/guides/compose-nodes/): the two builders,
  option by option.
- [API reference](/reference/api/): every export of all ten modules.
- [Troubleshooting](/troubleshooting/): every failure this package throws or
  records, with its cause and its fix.
