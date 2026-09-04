---
title: "@smthrs/plan"
description: "The persisted plan: a keyed action graph, its append-only store, its diff, and the step-key compiler that gives every node its identity."
---

`@smthrs/plan` is the plan phase of a Smithers run, as a value.

A plan is a graph of nodes with every key computed. It is produced before
anything executes and is inert until something drives it. This package is that
value made durable and nothing more: it performs no I/O beyond the database and
never executes a node. Driving a plan is `PlanScheduler`, in
[`@smthrs/engine-store`](/api/engine-store).

Two layers live here, and they meet at one type:

- The **authoring AST**. `Node` describes a plan as pure, pipeable data, and
  `Planned` is the strict placeholder a flow body sees where a step result will
  be. Both build plans; neither runs one.
- The **persisted plan**. `Plan.compile` turns node drafts into a keyed graph
  with a digest, `PlanStore` writes that graph to append-only SQL, and
  `PlanDiff` compares two of them.

The type in the middle is `Plan.NodeDraft`. [`@smthrs/flow`](/api/flow) walks a
flow body into drafts, and `Plan.compile` takes drafts.

## Who uses this package

Flow authors reach for `Node` and `Planned` when a body needs a decision, a
join, or a scheduling priority. Hosts and control planes reach for
`Plan.compile`, `PlanStore`, and `PlanDiff` to build the plan an operator
approves, keep it, and report what a re-plan changed.

If you author flows and never touch a control plane, you probably want
[`@smthrs/flow`](/api/flow) and can treat this package as the vocabulary its
plans are made of.

## Install

```bash
pnpm add @smthrs/plan
```

For peer requirements and the packages a persisting composition adds, see
[Installation](./installation.md).

## The smallest real plan

Two nodes, the second consuming the first:

```ts
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as KeyMaterial from "@smthrs/plan/KeyMaterial"
import * as Plan from "@smthrs/plan/Plan"
import * as Effect from "effect/Effect"

const plan = Plan.compile({
  planId: "review-4821",
  flow: "example/Review",
  nodes: [
    {
      id: "read-pr",
      material: {
        version: KeyMaterial.version,
        kind: "sealed",
        body: { action: "read-pr", pr: 4821 },
        inputs: [],
        layers: [],
        capabilities: ["net:get"]
      },
      effects: { reads: [], writes: ["pr.json"], boundaryMode: "hard" }
    },
    {
      id: "run-tests",
      material: {
        version: KeyMaterial.version,
        kind: "sealed",
        body: { action: "run-tests" },
        inputs: [{ _tag: "Ref", from: "read-pr", path: [] }],
        layers: [],
        capabilities: []
      },
      effects: { reads: ["pr.json"], writes: ["report.json"], boundaryMode: "hard" }
    }
  ]
}).pipe(Effect.provide(NodeCrypto.layer))
```

Compiling asks for Effect's `Crypto` service and nothing else. The result
carries both node keys, the edge `run-tests` depends on, and the digest an
approval binds to.

## The four rules this package exists to keep

**Planning demands nothing.** A `Node` carries Effect's requirement channel,
`R`, as a phantom. No combinator reads it, so building a plan asks for no
service at all. The channel states which implementations running the plan will
need, and the place that runs it asks for them.

**Planning performs no I/O.** Nothing here reads a file, a clock, or a network.
A node's declared `effects` carry read and write _paths_, never digests,
because measuring a path is the scheduler's run-time job.

**Invalidation is re-keying.** A node's key is a function of what it consumes,
so an edited declaration re-keys that node and its dependent cone and nothing
else. There is deliberately no reverse-dependency index and no invalidating
node visitor: content addressing subsumes both.

**A plan grows; it is never rewritten.** `Plan.append` adds a pre-keyed
subgraph at the next generation. Recorded nodes keep their id, key, edges, and
generation byte for byte, and the SQL raises rather than letting a caller
update or delete one.

## The package at a glance

The root entry point exports these namespaces, and each is also importable from
`@smthrs/plan/<Module>`:

| Namespace         | What it is                                                                                                |
| ----------------- | --------------------------------------------------------------------------------------------------------- |
| `Node`            | The pure, pipeable authoring AST: `succeed`, `all`, `map`, `andThen`, `branch`, `catch`, `priority`.      |
| `Planned`         | The strict placeholder a body sees where a step result will be, and the reference it records.             |
| `GraphBuildError` | The refusals a plan-time build raises instead of producing a wrong plan.                                  |
| `FileSet`         | The static filesystem vocabulary: patterns, globs, tree artifacts, filegroups, and overlap.               |
| `KeyMaterial`     | What a planner declares about a node: body, tagged input references, layers, capabilities, effects.       |
| `StepKey`         | The compiler that turns material plus resolved dependency digests into a [`@smthrs/keys`](/api/keys) key. |
| `Plan`            | `compile`, `append`, the node and conflict schemas, and the digest an approval binds to.                  |
| `PlanDiff`        | A plan comparison as a value: added, removed, re-keyed with attribution, unchanged.                       |
| `PlanStore`       | Append-only SQL persistence, enforced by triggers rather than by convention.                              |
| `Migrations`      | The namespaced migration set that owns the three plan tables in id block `4000`.                          |

Every export of every namespace, with signatures and refusals, is on the
[API reference](./api.md).

## Where to go next

- [Installation](./installation.md): peer requirements, import forms, and what
  a persisting composition adds.
- [Quickstart](./quickstart.md): compile a plan, record it in SQLite, and read
  it back.
- Concepts: [the plan value](./concepts/plan-value.md),
  [step keys](./concepts/step-keys.md),
  [declared effects and conflicts](./concepts/effects-and-conflicts.md), and
  [the authoring AST](./concepts/authoring-ast.md).
- Guides: [author a node graph](./guides/author-a-node-graph.md),
  [compile drafts into a plan](./guides/compile-a-plan.md),
  [persist a plan](./guides/persist-a-plan.md),
  [append a generation](./guides/append-a-generation.md),
  [diff two plans](./guides/diff-two-plans.md), and
  [declare the files a node touches](./guides/declare-file-effects.md).
- [Testing](./testing.md): what the package's own suites pin, and how to test
  code that builds plans.
- [Troubleshooting](./troubleshooting.md): every refusal this package raises,
  what causes it, and what to change.

The command line surfaces this package through
[`smthrs plan`](/cli/plan), which prints the plan card and the approval payload
that [`smthrs approve`](/cli/approve) and [`smthrs run`](/cli/run) accept.
