---
description: "The persisted plan: a keyed action graph, its authoring AST, its append-only store, and its diff."
---

# @smthrs/plan

The persisted plan: a keyed action graph, its append-only store, its diff, and the step-key compiler that gives every node its identity. Above the persisted form sits the authoring AST: `Node` describes a plan as pure data, and `Planned` is the placeholder a body sees where a step result will be.

The package performs no I/O beyond the database and executes nothing. Driving a plan is [`@smthrs/engine-store`](/api/engine-store)'s `PlanScheduler`.

```ts
import { Plan, PlanStore } from "@smthrs/plan"
import * as Effect from "effect/Effect"

const program = Effect.gen(function*() {
  const plan = yield* Plan.compile({
    planId: "review-4821",
    flow: "example/Review",
    nodes: [
      {
        id: "read-pr",
        material: {
          version: "flows/key-material/v1",
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
          version: "flows/key-material/v1",
          kind: "sealed",
          body: { action: "run-tests" },
          inputs: [{ _tag: "Ref", from: "read-pr", path: [] }],
          layers: [],
          capabilities: []
        },
        effects: { reads: ["pr.json"], writes: ["report.json"], boundaryMode: "hard" }
      }
    ]
  })

  const store = yield* PlanStore.PlanStore
  yield* store.record(plan, Date.now())
})
```

## Entry point

| Import | Source | Platform |
| --- | --- | --- |
| `@smthrs/plan` | [src/index.ts](https://github.com/smithersai/smithers/blob/main/packages/plan/src/index.ts) | Node and browser |

## KeyMaterial

[src/KeyMaterial.ts](https://github.com/smithersai/smithers/blob/main/packages/plan/src/KeyMaterial.ts)

What a planner declares about one node, handed to the compiler.

| Export | Kind | Notes |
| --- | --- | --- |
| `KeyMaterial` | schema + type | `version`, `kind`, `body`, `inputs`, `layers`, `capabilities`, optional `effects` and `placement` |
| `InputRef` | schema + type | tagged union of `Literal`, `Ref` (node id plus projection path), and `Pending` (node id alone) |
| `version` | constant | `flows/key-material/v1`, folded into every hashed body so a bump re-keys everything derived from it |
| `dependencies` | accessor | the graph-local node ids a material names, in declaration order and without duplicates |

`kind` is `sealed`, `compensable`, or `irreversible`. The `InputRef` tag is hashed, so `Pending{from}` and `Ref{from, path: []}` cannot collide even though both resolve to the same dependency digest.

`dependencies` is the single derivation of a node's edge set, so a hashed reference and an edge can never disagree. `effects` and `placement` are canonically serialized and never interpreted, which keeps the compiler independent of whatever the flow builder decides an effect declaration looks like.

## StepKey

[src/StepKey.ts](https://github.com/smithersai/smithers/blob/main/packages/plan/src/StepKey.ts)

The compiler from material to a [`@smthrs/keys`](/api/keys) `Key`.

| Export | Kind | Notes |
| --- | --- | --- |
| `fromKeyMaterial` | constructor | substitutes each `Ref` and `Pending` for the already-computed key of the referenced node, then builds a content key |
| `content` | constructor | a cross-run reusable key from a `ContentIdentity` |
| `ordinal` | constructor | a deliberately run-local key from an `OrdinalIdentity` |
| `StepKey` | type | the same `key1_` representation as any other flow key |
| `digestInput`, `isDigestInput`, `DigestInput` | constructor + guard + interface | nominally brands a precomputed digest so it hashes as a digest reference |
| `ContentIdentity` | interface | `body`, `inputs`, `layers`, `capabilities`, optional `environment` and `hermetic` |
| `EnvironmentIdentity` | interface | `declared`, `layers`, `capabilities`, optional `runScope` |
| `OrdinalIdentity` | interface | `runId`, optional `parentScope`, `ordinal`, `tier` |
| `KeyMaterialError` | class | `code: "missing_dependency"` or `"non_content_material"` |

Structural node ids are lookup addresses only and never enter the hashed value. Rename a node and nothing re-keys; change what a node consumes and everything downstream of it does. Only `sealed` material may become a content key, so `fromKeyMaterial` fails `non_content_material` for the other two tiers.

The brand behind `digestInput` is private, so a plain object that merely has a `digest` field hashes as a literal. That closes a collision where shape sniffing hashed a genuine upstream-result reference and an ordinary content hash identically.

`environment` is hashed in its own namespace rather than merged into the caller's declarations, so `caller{fs:["a"]} + env{fs:["b"]}` cannot alias `caller{fs:["a","b"]} + env{}`. Environment layers keep declaration order because composition order can change behavior; caller-owned layers are set-normalized. `runScope` is set only when `declared` is `false`, pinning the key to one run so a step whose environment identity is unknown never serves a cross-run hit.

`OrdinalIdentity.tier` is `compensable`, `irreversible`, or `unsealed`.

## Plan

[src/Plan.ts](https://github.com/smithersai/smithers/blob/main/packages/plan/src/Plan.ts)

| Export | Kind | Notes |
| --- | --- | --- |
| `compile` | constructor | topological order, dependency-digest substitution, overlap annotation, and the plan digest; no I/O |
| `append` | constructor | adds a pre-keyed subgraph at the next generation |
| `generationNodes` | accessor | the nodes added by the newest generation |
| `Plan` | schema + type | `planId`, `flow`, `generation`, `baseDigest`, `digest`, `nodes` |
| `PlanNode` | schema + type | `id`, `kind`, `key`, `material`, `effects`, `dependsOn`, `conflicts`, `strategy`, `runtime`, `priority`, `generation` |
| `NodeDraft` | interface | a node without its key, plus optional `kind`, `priority`, `conflictStrategy`, `runtimeStrategy` |
| `KeyDigest` | schema | compatibility alias of `@smthrs/keys` `StoredKey`; currently `key1_` plus 64 hex characters |
| `NodeEffects` | schema + type | `reads`, `writes`, and a `boundaryMode` of `hard` or `expected` |
| `ConflictAnnotation` | schema + type | `with`, `paths`, `strategy`, `runtime` |
| `PairStrategy` | schema + type | `serialize`, `lane`, `fail` |
| `RuntimeStrategy` | schema + type | `delay-rebase`, `stop-merge` |
| `PlanError` | class | `cycle`, `unknown_dependency`, `duplicate_node`, `overlap_forbidden` |

`PlanNode.kind` is `step`, `agent`, or `merge`. `dependsOn` is the edge set: material references plus any ordering edge a `serialize` verdict added. Ordering edges are deliberately not key material, so a node serialized behind another keeps its cache hit.

Planning performs no I/O. Declared `NodeEffects` carry read and write *paths*, never digests, because measuring a path is run-time work. A node's key is a function of what it consumes, so an edited declaration re-keys that node and its dependent cone and nothing else. That is the entire invalidation mechanism: there is no reverse-dependency index and no invalidating node visitor, because content addressing subsumes both.

A plan grows and is never rewritten. `append` leaves the nodes already in it with their id, key, edges, and generation byte for byte, and the new nodes arrive pre-keyed against them. Re-ordering after a reconciliation happens by re-keying future steps.

`baseDigest` is the digest at generation 0: what a human approved and what a running run pins. `digest` advances with every appended elaboration. Both cover node identity, every computed key, the edge set, the conflict annotations, the declared effects, and priority.

### Conflict annotations

Declared write sets make overlap detectable at plan time. Writers already ordered by a dependency path are not conflicts. Every other overlapping pair is annotated on both members with the resolved verdict.

| Verdict | Effect |
| --- | --- |
| `serialize` | the default; the later writer gains an ordering edge |
| `lane` | both writers get lane annotations when either asks for one, and no ordering edge |
| `fail` | `compile` fails with `overlap_forbidden`, for flows that promise disjointness |

`fail` dominates `lane`, which dominates `serialize`. Each annotation also carries the runtime strategy the pair resolved to, where `stop-merge` dominates `delay-rebase`; that is what the scheduler does when the predicted overlap actually bites. Nodes frozen by an earlier generation are annotated on the new node only, because their rows are append-only.

## Node

[src/Node.ts](https://github.com/smithersai/smithers/blob/main/packages/plan/src/Node.ts)

The pure, pipeable authoring AST. Building a node records an inspectable, closure-free, JSON-serializable description and executes nothing.

| Export | Kind | Notes |
| --- | --- | --- |
| `succeed` | constructor | a node that succeeds with a constant |
| `all` | constructor | independent children combined by name, at plan-time-fixed width |
| `map` | combinator | a deferred pure transformation; the function is digested, not run |
| `andThen` | combinator | a node or a builder sequenced after this one |
| `branch` | combinator | `if` runs at run time on the real value; `then` and `else` are built once at plan time |
| `catch` | combinator | a statically planned typed-failure arm, optionally selected by a schema |
| `priority` | combinator | a scheduling hint copied onto `NodeDraft.priority`; inherited lexically, never part of a node key |
| `declaredPriority` | accessor | the priority a node states, or `undefined` when it inherits |
| `Node`, `Any`, `Success`, `Error` | interfaces + types | the node type and its variance helpers |
| `BranchOptions`, `CatchOptions` | interfaces | the two arm declarations |
| `Ast`, `FunctionIdentity`, `TypeId` | types | the stored AST and the digest standing in for a plan-time function |
| `isNode` | guard | |
| `branchSubject`, `catchSubject` | constants | the reference prefixes an arm's symbolic subject carries |

Map transforms; branch decides. Both branch arms are evaluated once, symbolically, so the exit condition and the handoff site are visible topology before anything runs. A plan is always a DAG, so there is no loop node: repetition lives one level up, in what a flow settles with.

The functions an author writes (a mapper, a continuation, a branch predicate) live in `WeakMap`s keyed by the AST node they belong to, and the AST keeps only a `FunctionIdentity` digest of their normalized source. The digest is what enters content identity; the `WeakMap` is what a run reaches for once it has the real value.

## Planned

[src/Planned.ts](https://github.com/smithersai/smithers/blob/main/packages/plan/src/Planned.ts)

| Export | Kind | Notes |
| --- | --- | --- |
| `Planned` | type | a branded step result that has not been produced yet; field access stays typed |
| `Reference`, `Identity` | interfaces | `{ node, path }`, plus the phantom type of the value it stands for |
| `make` | constructor | the strict placeholder standing for a node's result |
| `reference` | accessor | the reference a planned value records, or `undefined` |
| `isPlanned` | guard | |
| `TypeId` | symbol | interned, so a value that crossed a module boundary is still recognised |

A planned value may be passed into a payload field, into a branch, or into a map, and field access is allowed, because it records a reference path.

:::danger
A planned value may never be computed on.
:::

Misuse fails twice. The type is branded, so arithmetic and template interpolation are compile errors; and the proxy's `Symbol.toPrimitive`, `valueOf`, `toString`, `toJSON`, application, `in`, and enumeration traps throw rather than let a plan be built around `NaN` or `"[object Object]"`. JavaScript exposes no trap for `Boolean(value)` or strict identity, so those cannot be refused at run time; they reveal only proxy truthiness or identity and never the planned result.

## GraphBuildError

[src/GraphBuildError.ts](https://github.com/smithersai/smithers/blob/main/packages/plan/src/GraphBuildError.ts)

The refusals a plan-time build raises instead of producing a wrong plan. Each carries the site, `node` plus the recorded property `path`, and states the fix in `message`, because the author reading it is mid-body.

| `code` | Meaning |
| --- | --- |
| `planned_value_computed` | a body computed on a step result |
| `invalid_all_member` | `Node.all` received a non-node member |
| `invalid_continuation` | a branch arm, catch arm, or continuation did not return a node |
| `recursion_requires_boundary` | a flow calls itself inline instead of using a trampoline handoff or an explicit child boundary |
| `placement_requires_boundary` | an inline call's callee declares a placement the enclosing flow cannot satisfy |
| `invalid_priority` | `Node.priority` received a value that is not a safe integer |

`GraphBuildErrorCode` is a closed schema literal, so a caller may switch on it and a new refusal is a deliberate addition rather than a new free-form string.

## PlanDiff

[src/PlanDiff.ts](https://github.com/smithersai/smithers/blob/main/packages/plan/src/PlanDiff.ts)

| Export | Kind | Notes |
| --- | --- | --- |
| `diff` | constructor | compares a plan against the last plan for the same flow |
| `PlanDiff` | interface | `added`, `removed`, `rekeyed`, `unchanged` |
| `Rekeyed` | interface | `id`, `from`, `to`, and the `changed` field labels |

The verdict is the key: two nodes with the same id and the same key are the same step. The attribution, `changed: ["body", "input[1]"]`, is a report for a human, derived by comparing declarations field by field, and is deliberately part of no digest. Labels are `body`, `layers`, `capabilities`, `effects`, `version`, and `input[n]`, including `input[n]` entries whose declaration is unchanged but whose referenced node itself re-keyed. A node re-keyed purely by an upstream edit is therefore attributed to the input position that references it, even behind an unprojected `Pending`, rather than reported as nothing changed.

## PlanStore

[src/PlanStore.ts](https://github.com/smithersai/smithers/blob/main/packages/plan/src/PlanStore.ts)

| Export | Kind | Notes |
| --- | --- | --- |
| `PlanStore` | service tag | `@smthrs/plan/PlanStore` |
| `Service` | interface | `record`, `append`, `get` |
| `make`, `layer` | SQL implementation | over `DurableWriter` and Effect's `SqlClient` |
| `RecordResult` | type | `Recorded`, `ExistingSame`, or `Conflict` carrying the existing digest |
| `PlanStoreError`, `PlanStoreErrorCode` | class + schema | `invalid_plan`, `constraint`, `decode_failed`, `persistence_failed`, `unknown` |

`record` is first-writer-wins in the shape `CacheStore.put` established: an identical re-record is not an error, and a different plan under the same id is a conflict rather than a silent overwrite. `get` returns the whole plan with nodes in recorded order.

`append` refuses a plan that was never recorded with a `constraint` error. The refusal matters because of the append-only triggers: without it the node rows would land while the plan-row update matched nothing, leaving a generation of a plan that does not exist and that nothing is allowed to delete. The whole append is one transaction, so the refusal takes the rows back with it.

## Migrations

[src/Migrations.ts](https://github.com/smithersai/smithers/blob/main/packages/plan/src/Migrations.ts)

| Export | Kind | Notes |
| --- | --- | --- |
| `set` | `MigrationSet` | the namespaced set for `flows_plans`, `flows_plan_nodes`, and `flows_plan_edges`, in id block `4000` |
| `run` | effect | apply this set alone |
| `layer` | layer | applies it at construction |

Block `4000` is the next free block after the journal (`0`), the run store (`1000`), the step cache (`2000`), and the engine store (`3000`). [`@smthrs/engine-store`](/api/engine-store)'s `Migrations.sets` composes this set last, because `Migrator` decides what to run from a single high-water mark and a set whose ids sit below an already-applied one would be assumed done.

Append-only is enforced in SQL rather than by convention. Triggers raise on any UPDATE or DELETE of `flows_plan_nodes` and `flows_plan_edges`, and `flows_plans` accepts only an UPDATE that raises the generation and leaves `base_digest` alone. The migration also creates the `flows_plan_nodes_order` index.

## API reference

This page is the public API reference for the **persisted plan**: a keyed
action graph, its append-only store, its diff, and the step-key compiler that
gives every node its identity.

`docs/specs/Specs/Object Model.md` defines a `Plan` as "a `Node` graph with
every key computed, produced by the plan phase and inert until run". That is
exactly what this package is, and no more: it performs no I/O beyond the
database and executes nothing. Driving a plan is
[`@smthrs/engine-store`](/api/engine-store)'s `PlanScheduler`.

The package depends on `@smthrs/database`, `@smthrs/keys`, and `effect`. It is
browser-safe.

### KeyMaterial

`KeyMaterial` is what a planner declares about one node: a `version`, a tier
`kind`, an opaque `body`, an ordered list of `InputRef`s, `layers`,
`capabilities`, and opaque `effects` / `placement`. An `InputRef` is one of
three *tagged* variants: `Literal`, `Ref` (with a projection path), and
`Pending`, and the tag is hashed, so `Pending{from}` and `Ref{from, path: []}`
cannot collide even though both resolve to the same dependency digest.

`KeyMaterial.dependencies` lists the graph-local nodes a material names, in
declaration order and without duplicates. It is the single derivation of a
node's edges, so a hashed reference and an edge can never disagree.

### StepKey

`StepKey` is the compiler: given a material and the already-computed keys of
its dependencies, it substitutes each reference for the dependency's digest and
returns a key.

`content` and `ordinal` are the two constructors underneath: a cross-run
reusable content key, and a deliberately run-local invocation key.
`digestInput` nominally brands a precomputed digest so it hashes as a digest
reference; a plain object that merely has a `digest` field hashes as a literal,
which is what closes the shape-sniffing collision. Set-like declarations are
normalized, and the engine-resolved `environment` is hashed in its own
namespace rather than merged into the caller's, so
`caller{fs:["a"]} + env{fs:["b"]}` cannot alias `caller{fs:["a","b"]} + env{}`.

Two deliberate deviations from the module this revives (deleted at `f5f3dda`):
it lives above `@smthrs/keys` rather than inside it, and it produces
`@smthrs/keys` `Key` values instead of a second `sk1_` digest format. The
engine dispatches under `Key`, so a plan whose node keys were a different
string format could never be the thing the cache is consulted against.

### Plan

`Plan.compile({ planId, flow, nodes })` topologically orders drafts by their
material dependencies, computes every key in that order, annotates detected
write-set overlaps, and derives the plan digest. It performs no I/O: declared
`effects` carry read and write *paths*, never digests, because measuring a path
is run-time work.

`Node.priority(node, n)` is the authoring call that attaches the hint, and
`Node.declaredPriority(ast)` reads back the value a node states, or `undefined`
when it inherits one. `NodeDraft.priority` is the hint an author attached that
way. `Plan.compile` copies it onto the plan node, defaulting to zero, and folds
it into the plan digest, because the order a human approved is part of what
they approved. It is deliberately absent from a node's key: a node scheduled
ahead of another computes the same result, so re-keying it would throw away a
legitimate cache hit. `PlanScheduler` orders ready nodes by that priority plus
one aging point per capacity-constrained pass.

`Plan.append(plan, drafts)` grows a plan. Nodes already in it keep their id,
key, edges, and generation byte for byte; the new nodes arrive pre-keyed
against them at the next generation. `Plan.generationNodes` returns the newest
generation, which is what the store appends and what the `subgraph-appended`
journal record names.

`Plan.PlanError` refuses four graphs: `cycle`, `unknown_dependency`,
`duplicate_node`, and `overlap_forbidden`.

#### Conflict annotations

Declared write sets make overlap detectable at plan time. Writers already
ordered by a dependency path are not conflicts. For every other overlapping
pair, both members are annotated with the resolved verdict:

| Verdict     | Effect                                                                     |
| ----------- | -------------------------------------------------------------------------- |
| `serialize` | The default. The later writer gains an ordering edge                       |
| `lane`      | Both get lane annotations when either asks for one; no ordering edge        |
| `fail`      | `compile` fails, for flows that promise disjointness                       |

An ordering edge is **not** key material: a node serialized behind another
computes the same result, so re-keying it would throw away a legitimate cache
hit. Each annotation also carries a runtime strategy: `delay-rebase` or
`stop-merge`, which is what the scheduler does when the predicted overlap
actually bites.

### PlanDiff

`PlanDiff.diff(previous, next)` is `smithers plan --diff` as a value: `added`,
`removed`, `rekeyed`, `unchanged`. The **verdict** is the key, two nodes with
the same id and key are the same step. The **attribution** on a re-keyed node
(`changed: ["body", "input[1]"]`) is a report for a human, derived field by
field, and is deliberately part of no digest.

### PlanStore

`PlanStore` exposes `record`, `append`, and `get`. `record` is first-writer-wins
in the shape `CacheStore.put` established: `Recorded`, `ExistingSame`, or
`Conflict` carrying the existing digest, so an identical re-record is not an
error and a different plan under the same id is never a silent overwrite.

Append-only is enforced **in SQL, not by convention**: triggers on
`flows_plan_nodes` and `flows_plan_edges` raise on any UPDATE or DELETE, and
the `flows_plans` row accepts only an update that raises the generation and
leaves the approved base digest alone.

`append` grows a plan that was recorded, and refuses one that was not with a
`constraint` error. The refusal matters precisely *because* of those triggers:
the node rows would land while the plan row's update matched nothing, leaving a
generation of a plan that does not exist and that nothing is allowed to delete.
The whole append is one transaction, so the refusal takes the rows back with
it.

### Migrations

The package owns `flows_plans`, `flows_plan_nodes`, and `flows_plan_edges`, and
reserves migration id block `4000`: the next free block after the journal
(`0`), run store (`1000`), step cache (`2000`), and engine store (`3000`). It
is the last set in
[`@smthrs/engine-store`](/api/engine-store)'s `Migrations.sets`, because
`Migrator` decides what to run from one high-water mark and a set below an
applied id would be assumed done.
