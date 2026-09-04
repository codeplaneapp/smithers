---
title: "@smthrs/core"
description: "The pure plan-time data model of the Smithers harness: inert flow and node declarations, the graph they reveal when planned, and the key material a durable engine turns into step keys."
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/core/docs/README.md"
---

`@smthrs/core` is the data model a plan is made of, before anything runs.

Every value this package constructs is inert. A flow is a schema-described
declaration. A node is a pipeable value that records an AST. A graph is the
topology those two reveal when `Graph.build` walks them. Nothing here executes a
step, resolves a registry name, opens a file, or calls a model.

## The problem it solves

A durable engine cannot start a step until it knows two things: the shape of the
whole plan, and the identity of each step in it. Identity is what lets a resumed
run skip work it already finished, and what lets two runs share a cached result.
Both answers have to exist before the first step runs, which means they cannot
come from executing anything.

`Graph.build` produces both. It evaluates flow bodies and `Node.andThen`
builders exactly once, against symbolic placeholder values, so the complete
static topology is visible without running a single step. Each node in the
result carries digest-free key material, which [`@smthrs/keys`](https://keys.smithers.sh/reference/api/)
compiles into the step key the engine caches on.

## Install

```bash
pnpm add @smthrs/core
```

For import forms and what a real composition adds, see
[Installation](/installation/).

## The smallest real example

```ts
import { Flow, Graph, Node, Placement } from "@smthrs/core"
import * as Schema from "effect/Schema"

const Greeting = Flow.make({
  name: "greeting",
  input: Schema.Struct({ name: Schema.String }),
  output: Schema.String,
  body: ({ name }) => Node.succeed(`Hello, ${name}`)
}).pipe(Flow.within(Placement.sandbox()))

const graph = Graph.build(Greeting, { name: "world" })
```

`Greeting` never ran. `graph` holds its nodes, its edges, the placement each
node inherited, and the key material each node keys on. For a runnable
walkthrough that reads all of that back, see the
[Quickstart](/quickstart/).

## Who uses this package

Packages that build declarations on top of it and hosts that execute what those
declarations describe. [`@smthrs/registry`](https://registry.smithers.sh/reference/api/) lowers markdown and
Agent Skills documents into `Flow` values through this package's `Markdown`
module. [`@smthrs/harness`](https://harness.smithers.sh/reference/api/) reads `Effects`, `Placement`, and
`KeyMaterial` at its durable boundary. [`@smthrs/agent`](https://agent.smithers.sh/reference/api/) and
[`@smthrs/control`](https://control.smithers.sh/reference/api/) run what the plan describes.

Note that [`@smthrs/flow`](https://flow.smithers.sh/reference/api/), the authoring package for durable
workflows, carries its own adapted plan model and does not depend on this one.
Reach for `@smthrs/core` when you are building the harness layer, not when you
are writing a workflow.

## The package at a glance

The root entry point exports these namespaces, and each is also importable from
`@smthrs/core/<Module>`:

| Namespace     | What it is                                                                                                       |
| ------------- | ---------------------------------------------------------------------------------------------------------------- |
| `Flow`        | Callable, schema-described flow declarations and the combinators that copy them.                                 |
| `Node`        | The inert, pipeable AST a flow body returns: constants, joins, maps, continuations, and recovery arms.           |
| `Graph`       | The planner: it walks a declaration once and returns a frozen graph of nodes, edges, conflicts, and diagnostics. |
| `Effects`     | Normalized read and write declarations, plus coverage, narrowing, and overlap analysis.                          |
| `Placement`   | Serializable directives naming where a node should run: local, client, sandbox, or remote.                       |
| `Annotations` | The typed annotation bag nodes and flows carry, and the four keys this package defines.                          |
| `KeyMaterial` | The digest-free projection a built node hands to the key compiler. Types only.                                   |
| `Markdown`    | Agent Skills parsing and validation, and the lowering of a markdown prompt into an ordinary flow.                |
| `Digest`      | Synchronous SHA-256 and RFC 8785 canonical JSON, for identity built inside pure constructors.                    |
| `TestRuntime` | A pure evaluator that runs the deferred callbacks a node AST stores. Tests only, never production.               |

Every export, with signatures and errors, is on the
[API reference](/reference/api/).

## Where to go next

- [Installation](/installation/): requirements, import forms, and the
  subpaths that are not public.
- [Quickstart](/quickstart/): declare two flows, plan them, and read the
  graph and its key material back.
- Concepts: [plan time](/concepts/plan-time/),
  [identity and key material](/concepts/identity/),
  [effect envelopes](/concepts/effects/), and
  [build limits](/concepts/limits/).
- Guides: [declare a flow](/guides/declare-a-flow/),
  [compose nodes](/guides/compose-nodes/),
  [inspect a graph](/guides/inspect-a-graph/),
  [keep a step key stable](/guides/keep-a-step-key-stable/),
  [declare reads and writes](/guides/declare-reads-and-writes/),
  [annotate a node](/guides/annotate-a-node/),
  [test a declaration](/guides/test-a-declaration/), and
  [load an Agent Skill](/guides/load-an-agent-skill/).
- [Troubleshooting](/troubleshooting/): the failures this package raises and
  records, what causes each, and what to change.
