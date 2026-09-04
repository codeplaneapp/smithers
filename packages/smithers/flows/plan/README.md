# @smthrs/plan

**Documentation:** https://plan.smithers.sh

The persisted plan: a keyed action graph, its append-only store, its diff, and
the step-key compiler that gives every node its identity.

A plan is a `Node` graph with every key computed, produced by the plan phase
and inert until run. This package is that value made durable and nothing more.
It performs no I/O beyond the database and never executes anything; driving a
plan is `@smthrs/engine-store`'s `PlanScheduler`.

```ts
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
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
          version: "flows/key-material/v2",
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
          version: "flows/key-material/v2",
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
  return yield* store.record(plan, Date.now())
}).pipe(Effect.provide(NodeCrypto.layer))
```

Compiling needs Effect's `Crypto` service and nothing else. Recording
additionally needs `PlanStore.layer` over a `DurableWriter` and a `SqlClient`.

## What is in here

| Module            | Role                                                                                                                                                 |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Node`            | The pure, pipeable authoring AST: `succeed`, `all`, `map`, `andThen`, `branch`, `catch`, `priority`                                                  |
| `Planned`         | The strict placeholder a body sees where a step result will be, and the reference it records                                                         |
| `GraphBuildError` | The refusals a plan-time build raises instead of producing a wrong plan                                                                              |
| `FileSet`         | The static filesystem declaration vocabulary: patterns, globs, tree artifacts, filegroups, overlap                                                   |
| `KeyMaterial`     | What a planner declares about a node: body, tagged input references, layers, capabilities, effects                                                   |
| `StepKey`         | The compiler that turns material plus resolved dependency digests into an `@smthrs/keys` `Key`                                                       |
| `Plan`            | `compile`, `append`, the node/edge/conflict schemas, and the digest an approval binds to                                                             |
| `PlanDiff`        | A plan comparison as a value: added, removed, re-keyed (with attribution), unchanged                                                                 |
| `PlanStore`       | Append-only SQL persistence, migration block `4000`, enforced by triggers rather than by convention                                                  |
| `Migrations`      | The namespaced migration set, composed by `@smthrs/engine-store`'s `Migrations.sets`; its ordered steps live under `internal` and are not importable |

## The four rules this package exists to keep

**Planning demands nothing.** A `Node` carries Effect's requirement channel,
`R`, and carries it as a phantom: no combinator here reads it, and the AST, the
graph, the key material, and every digest are identical whatever it says.
Building a plan therefore asks for no service at all. What fills the channel is
a call to something whose code lives elsewhere, an action, so a plan's type
states which implementations running it will need, and the place that runs it
(`Flow.execute`, in `@smthrs/flow`) is where the compiler asks for them.
Each combinator unions its parts: `all` over its members, `map` and `andThen`
along the chain, `branch` over BOTH arms and `catch` over its failure arm,
because both arms of a decision are topology the plan carries and a run has to
be able to take either.

**Planning performs no I/O.** Nothing here reads a file, a clock, or a network.
A node's declared `effects` carry read and write _paths_, never digests, since
measuring them is the scheduler's run-time job.

**Invalidation is re-keying.** A node's key is a function of what it consumes,
so an edited declaration re-keys that node and its dependent cone and nothing
else. There is deliberately **no reverse-dependency index and no invalidating
node visitor**: content addressing subsumes both, and re-adding one would be a
regression, not an optimisation.

**A plan grows; it is never rewritten.** `append` adds a pre-keyed subgraph at
the next generation. Recorded nodes keep their id, key, edges, and generation
byte for byte, and the SQL raises rather than letting a caller update or delete
one. Re-ordering after a reconciliation happens by re-keying _future_ steps.
Growth implies something to grow: appending to a plan that was never recorded,
or over a skipped generation, is a `constraint` refusal, because the
alternative is node rows for a plan that does not exist and that the
append-only triggers then forbid removing.

## Conflict annotations

Declared write sets make overlap detectable at plan time. `compile` annotates
both members of every overlapping pair that no dependency path already orders:

- `serialize` is the default; the later writer gains an ordering edge. The edge
  is **not** key material, so a serialized node keeps its cache hit.
- `lane` gives both writers lane annotations when either asks for one, and no
  ordering edge, because the lanes run concurrently and merge back.
- `fail` refuses the compile, for flows that promise disjointness.

Each annotation also carries a runtime strategy, `delay-rebase` or
`stop-merge`, which is what the scheduler does when the predicted overlap
actually bites. Both the pair strategy and the runtime strategy are folded into
the plan digest a human approves.

A node that reads a path another node writes is not a conflict but a missing
edge: `compile` puts the reader behind its producer by growing `dependsOn`.
When a declared dependency or a `serialize` edge already orders the producer
behind its reader, no edge set satisfies both, and `compile` fails with `cycle`
naming the reader, the producer, the overlapping paths, and the dependency
chain. Dropping the edge instead would let the reader measure and cache
pre-producer bytes as a legitimate execution.

## When it refuses

`Plan.compile` and `Plan.append` fail with a `PlanError` carrying one of seven
stable codes: `cycle` (material dependencies close a loop, or a
reader-after-writer edge would), `unknown_dependency`, `duplicate_node`,
`overlap_forbidden`, `invalid_effects` (one path declared as both a write and a
removal), `invalid_node` (an empty plan id or node id, a priority that is not a
safe integer, a `kind` or strategy outside its literal set, or key material or
an effect declaration this release cannot decode, which includes a path that is
not workspace-relative), and `graph_too_large` (more than
`Plan.maximumPlanNodes` nodes). They also surface
`StepKey.KeyMaterialError` for a missing dependency digest, non-content
material, or an invalid environment identity, and Effect's `SchemaError` when a
declaration has no canonical serialization.

`PlanStore.record` answers with a `RecordResult`: `Recorded` for the first
writer, `ExistingSame` for an identical re-record, or `Conflict` carrying the
digest already stored. Every store failure is a `PlanStoreError` whose `code`
is one of `invalid_plan`, `constraint`, `decode_failed`, `persistence_failed`,
or `unknown`.

A plan-time build refuses through `GraphBuildError`, whose closed code set
names the site and the fix: `planned_value_computed`, `invalid_all_member`,
`invalid_continuation`, `recursion_requires_boundary`,
`placement_requires_boundary`, `cyclic_payload`, `payload_too_deep`,
`graph_too_deep`, `duplicate_node`, `invalid_priority`, and `invalid_payload`.

## Path and payload rules

Declared paths are workspace-relative and are compared in one spelling.
`FileSet.canonical` rewrites every separator to `/` and normalizes to Unicode
NFC, so the backslash spelling and the NFD spelling of one file overlap.
`FileSet.workspaceRelative` refuses absolute paths, drive letters, `..` and `.`
segments, empty segments, the C0 control range, and DEL. C1 bytes stay legal,
because a POSIX file name may contain them.

A node payload is stored as its inert JSON mirror: a data-valued callable
`toJSON` is honoured, a function or symbol member is dropped from an object and
becomes `null` in an array, and shared references and cycles clone as they were
written. Accessors and unsupported prototypes without `toJSON` fail with
`invalid_payload` instead of executing author code or collapsing distinct
values onto `{}`, and a `toJSON` returning its own receiver fails with
`cyclic_payload`. The mirror and the value it was taken from therefore key
identically or refuse together.

A `Planned` placeholder may be passed into a payload field, a branch, or a map,
and field access is allowed because it records a reference path. It may never
be computed on: `Symbol.toPrimitive`, `valueOf`, `toString`, `toJSON`,
application, `in`, and enumeration all throw a `GraphBuildError`.

## Resource policy

`Node.capture` refuses a capture record nested past 256 levels with a
path-bearing `TypeError` rather than overflowing the native stack.
`Plan.compile` walks with explicit stacks and never recurses per edge. Its
conflict and reader-after-writer passes compare node pairs, so pair comparison
is quadratic in node count, and each pair whose write sets actually overlap adds
one on-demand reachability walk over the edge set. A plan whose write sets
barely overlap therefore costs about `n²` comparisons, while one whose writers
overlap densely costs more than quadratic. `Plan.maximumPlanNodes` bounds that
work: a plan above it is refused with `graph_too_large` before any pair is
compared.

A compiled plan is a deep-frozen snapshot, and its material is stored as the
inert JSON mirror the node's key already covers. Mutating the draft objects a
caller passed in cannot change the plan, its keys, or its digest. A material
accessor, or a prototype with no JSON representation, is refused as
`invalid_node` rather than stored by reference.

Effect identity flows through one channel. `Plan.compile` decodes
`NodeDraft.effects` and writes it into the hashed `material.effects`, replacing
whatever a caller supplied, so editing `reads`, `writes`, `removes`, or
`boundaryMode` re-keys the node instead of moving the approval digest behind an
unchanged key.

## Browser support

Browser-safe. The package resolves no `node:` built-in; `pnpm run browser` at the
repository root executes that claim.

Full API reference: [plan.smithers.sh](https://plan.smithers.sh/reference/api/).
