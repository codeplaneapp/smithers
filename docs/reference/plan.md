# `@smthrs/plan`

This page is the public API reference for the **persisted plan**: a keyed
action graph, its append-only store, its diff, and the step-key compiler that
gives every node its identity.

`docs/specs/Specs/Object Model.md` defines a `Plan` as "a `Node` graph with
every key computed, produced by the plan phase and inert until run". That is
exactly what this package is, and no more: it performs no I/O beyond the
database and executes nothing. Driving a plan is
[`@smthrs/engine-store`](engine-store.md)'s `PlanScheduler`.

The package depends on `@smthrs/database`, `@smthrs/keys`, and `effect`. It is
browser-safe.

## KeyMaterial

`KeyMaterial` is what a planner declares about one node: a `version`, a tier
`kind`, an opaque `body`, an ordered list of `InputRef`s, `layers`,
`capabilities`, and opaque `effects` / `placement`. An `InputRef` is one of
three *tagged* variants — `Literal`, `Ref` (with a projection path), and
`Pending` — and the tag is hashed, so `Pending{from}` and `Ref{from, path: []}`
cannot collide even though both resolve to the same dependency digest.

`KeyMaterial.dependencies` lists the graph-local nodes a material names, in
declaration order and without duplicates. It is the single derivation of a
node's edges, so a hashed reference and an edge can never disagree.

## StepKey

`StepKey` is the compiler: given a material and the already-computed keys of
its dependencies, it substitutes each reference for the dependency's digest and
returns a key.

`content` and `ordinal` are the two constructors underneath — a cross-run
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

## Plan

`Plan.compile({ planId, flow, nodes })` topologically orders drafts by their
material dependencies, computes every key in that order, annotates detected
write-set overlaps, and derives the plan digest. It performs no I/O — declared
`effects` carry read and write *paths*, never digests, because measuring a path
is run-time work.

`Plan.append(plan, drafts)` grows a plan. Nodes already in it keep their id,
key, edges, and generation byte for byte; the new nodes arrive pre-keyed
against them at the next generation. `Plan.generationNodes` returns the newest
generation, which is what the store appends and what the `subgraph-appended`
journal record names.

`Plan.PlanError` refuses four graphs: `cycle`, `unknown_dependency`,
`duplicate_node`, and `overlap_forbidden`.

### Conflict annotations

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
hit. Each annotation also carries a runtime strategy — `delay-rebase` or
`stop-merge` — which is what the scheduler does when the predicted overlap
actually bites.

## PlanDiff

`PlanDiff.diff(previous, next)` is `flows plan --diff` as a value: `added`,
`removed`, `rekeyed`, `unchanged`. The **verdict** is the key — two nodes with
the same id and key are the same step. The **attribution** on a re-keyed node
(`changed: ["body", "input[1]"]`) is a report for a human, derived field by
field, and is deliberately part of no digest.

## PlanStore

`PlanStore` exposes `record`, `append`, and `get`. `record` is first-writer-wins
in the shape `CacheStore.put` established — `Recorded`, `ExistingSame`, or
`Conflict` carrying the existing digest — so an identical re-record is not an
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

## Migrations

The package owns `flows_plans`, `flows_plan_nodes`, and `flows_plan_edges`, and
reserves migration id block `4000` — the next free block after the journal
(`0`), run store (`1000`), step cache (`2000`), and engine store (`3000`). It
is the last set in
[`@smthrs/engine-store`](engine-store.md)'s `Migrations.sets`, because
`Migrator` decides what to run from one high-water mark and a set below an
applied id would be assumed done.
