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

Compiling needs Effect's `Crypto` service and nothing else. Recording additionally needs `PlanStore.layer` over a `DurableWriter` and a `SqlClient`. The package depends on [`@smthrs/crypto`](/api/crypto), `@smthrs/database`, [`@smthrs/keys`](/api/keys), and `effect`, and is browser-safe.

## Entry point

| Import         | Source                                                                                                     | Platform         |
| -------------- | ---------------------------------------------------------------------------------------------------------- | ---------------- |
| `@smthrs/plan` | [src/index.ts](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/plan/src/index.ts) | Node and browser |

## KeyMaterial

[src/KeyMaterial.ts](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/plan/src/KeyMaterial.ts)

What a planner declares about one node, handed to the compiler: a `version`, a tier `kind`, an optional `nondeterministic` flag, an opaque `body`, an ordered list of `InputRef`s, `layers`, `capabilities`, and opaque `effects` and `placement`.

`kind` is `sealed`, `compensable`, or `irreversible`. Absence of `nondeterministic` claims determinism; only the explicit declaration changes identity. The `InputRef` tag is hashed, so `Pending{from}` and `Ref{from, path: []}` cannot collide even though both resolve to the same dependency digest.

`dependencies` is the single derivation of a node's edge set, so a hashed reference and an edge can never disagree. `StepKey` canonically serializes `effects` and `placement` and never interprets them, which keeps the key compiler independent of whatever the flow builder decides an effect declaration looks like. `Plan.compile` is stricter: it decodes `NodeDraft.effects` through `NodeEffects` and writes the result into `material.effects`, replacing anything a caller put there. That makes the draft declaration the single derivation point for effect identity, so a node's key cannot disagree with the effects its conflict annotations and approval payload were computed from.

## StepKey

[src/StepKey.ts](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/plan/src/StepKey.ts)

The compiler from material to a [`@smthrs/keys`](/api/keys) `Key`. `fromKeyMaterial` substitutes each `Ref` and `Pending` for the already-computed key of the referenced node, then builds a content key through `content`. `ordinal` mints the deliberately run-local key of compensable, irreversible, or unsealed work, whose `tier` is one of those three words.

Structural node ids are lookup addresses only and never enter the hashed value. Rename a node and nothing re-keys; change what a node consumes and everything downstream of it does. Only `sealed` material may become a content key, so `fromKeyMaterial` fails `non_content_material` for the other two tiers. A dependency digest is resolved as an own property, so a `Ref` naming `toString` or `constructor` is a `missing_dependency` refusal rather than a colliding key.

The brand behind `digestInput` is private, so a plain object that merely has a `digest` field hashes as a literal. That closes a collision where shape sniffing hashed a genuine upstream-result reference and an ordinary content hash identically.

`environment` is hashed in its own namespace rather than merged into the caller's declarations, so `caller{fs:["a"]} + env{fs:["b"]}` cannot alias `caller{fs:["a","b"]} + env{}`. Environment layers keep declaration order because composition order can change behavior; caller-owned layers are set-normalized. `EnvironmentIdentity` is a discriminated union: a declared environment carries no `runScope`, and an undeclared one must carry a non-empty one, pinning the key to a single run so a step whose environment identity is unknown never serves a cross-run hit. Both `content` and `dispatchIdentity` enforce that at run time with `invalid_environment`.

`project` is the one projection semantics for the value channel. It resolves only own data properties, so a path segment that is missing, inherited, or an accessor yields `undefined` and no getter runs during key derivation.

`KeyMaterialError` carries `invalid_environment`, `missing_dependency`, or `non_content_material`.

A `DigestMemo` shares one in-flight projected-value digest between concurrent callers. A waiter never inherits the leader's interruption: if the leader's fiber is cancelled, the waiter recomputes as the new leader.

## Plan

[src/Plan.ts](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/plan/src/Plan.ts)

`compile` puts drafts in topological order, substitutes dependency digests, annotates write-set overlaps, and derives the plan digest. `append` adds a pre-keyed subgraph at the next generation, and `generationNodes` reads back the nodes the newest generation added.

`PlanNode.kind` is `step`, `agent`, or `merge`. `dependsOn` is the edge set: material references, any ordering edge a `serialize` verdict added, and the reader-after-writer edges that put a node behind whoever produces the paths it reads. Ordering edges are deliberately not key material, so a node serialized behind another keeps its cache hit. A reader-after-writer edge that would close a cycle, because a declared dependency or a `serialize` edge already orders the producer behind its reader, is refused as `cycle` rather than dropped; the message names the reader, the producer, the overlapping paths, and the dependency chain. `NodeEffects` carries `reads`, `writes`, an optional `removes`, and a `boundaryMode` of `hard` or `expected`; a removal mutates the world exactly as a write does, so both plan passes treat the two as one set.

Planning performs no I/O. Declared effects carry read and write _paths_, never digests, because measuring a path is run-time work. A node's key is a function of what it consumes, so an edited declaration re-keys that node and its dependent cone and nothing else. That is the entire invalidation mechanism: there is no reverse-dependency index and no invalidating node visitor, because content addressing subsumes both.

A plan grows and is never rewritten. `append` leaves the nodes already in it with their id, key, edges, and generation byte for byte, and the new nodes arrive pre-keyed against them. Re-ordering after a reconciliation happens by re-keying future steps.

`baseDigest` is the digest at generation 0: what a human approved and what a running run pins. `digest` advances with every appended elaboration. Both cover node identity, every computed key, the edge set, the conflict annotations, the declared effects, the priority, and each node's own conflict and runtime strategies.

A compiled plan is a deep-frozen snapshot of the drafts it was given. Material is stored as the inert JSON mirror its key already covers, so a `Date`, a `URL`, or any value with a data-valued callable `toJSON` is stored as the value it serializes to, and mutating a caller's draft after compiling cannot change the plan, its keys, or its digest. A material accessor, or a prototype with no JSON representation, is refused as `invalid_node` naming the node and the payload path rather than stored by reference. A `Planned` placeholder is left intact so canonical serialization still refuses it.

`PlanError` is a closed set of seven codes.

| `code`               | Meaning                                                                                                                                                                                                                                            |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cycle`              | material dependencies close a cycle, or a reader-after-writer edge would close one                                                                                                                                                                 |
| `unknown_dependency` | a `Ref` or `Pending` names a node that is neither in the drafts nor already in the plan                                                                                                                                                            |
| `duplicate_node`     | a draft reuses an id the plan already holds                                                                                                                                                                                                        |
| `overlap_forbidden`  | a `fail` pair genuinely overlaps and no dependency path orders it                                                                                                                                                                                  |
| `invalid_effects`    | one path is declared as both a write and a removal                                                                                                                                                                                                 |
| `invalid_node`       | an empty plan id, flow, or node id, a priority that is not a safe integer, a `kind` or strategy outside its literal set, or key material or an effect declaration this release cannot decode, which includes a path that is not workspace-relative |
| `graph_too_large`    | a plan contains more than `Plan.maximumPlanNodes` nodes                                                                                                                                                                                            |

Compilation walks with explicit stacks and never recurses per edge. The conflict and reader-after-writer passes compare node pairs, so pair comparison is quadratic in node count, and each pair whose write sets actually overlap adds one on-demand reachability walk over the edge set. A plan whose write sets barely overlap costs about `n²` comparisons; one whose writers overlap densely costs more than quadratic. `Plan.maximumPlanNodes` bounds that work, because a plan above it is refused with `graph_too_large` before any pair is compared.

### Conflict annotations

Declared write sets make overlap detectable at plan time. Writers already ordered by a dependency path, including one ordered through an ordering edge this pass just inferred, are not conflicts. Every other overlapping pair is annotated on both members with the resolved verdict.

| Verdict     | Effect                                                                           |
| ----------- | -------------------------------------------------------------------------------- |
| `serialize` | the default; the later writer gains an ordering edge                             |
| `lane`      | both writers get lane annotations when either asks for one, and no ordering edge |
| `fail`      | `compile` fails with `overlap_forbidden`, for flows that promise disjointness    |

`fail` dominates `lane`, which dominates `serialize`. Each annotation also carries the runtime strategy the pair resolved to, where `stop-merge` dominates `delay-rebase`; that is what the scheduler does when the predicted overlap actually bites. Nodes frozen by an earlier generation are annotated on the new node only, because their rows are append-only.

## Node

[src/Node.ts](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/plan/src/Node.ts)

The pure, pipeable authoring AST. Building a node records an inspectable, closure-free, JSON-serializable description and executes nothing.

Map transforms; branch decides. Both branch arms are evaluated once, symbolically, so the exit condition and the handoff site are visible topology before anything runs. A plan is always a DAG, so there is no loop node: repetition lives one level up, in what a flow settles with.

A payload is stored as its inert JSON mirror. A data-valued callable `toJSON` is honoured, so a `Date` or a `URL` keys as the value it serializes to rather than as an empty object; a function or symbol member is dropped from an object and becomes `null` in an array; shared references and cycles clone as they were written. Accessors and unsupported prototypes without `toJSON` fail as `invalid_payload`, and a `toJSON` that returns its own receiver fails as `cyclic_payload` rather than collapsing to an empty object the way it once did. The clone and the input therefore key identically or refuse together.

`isNode` recognizes a node this package built by registration at construction, and a rehydrated node, an object sharing the node prototype whose own `ast` is a well-formed AST, by that shape, because `@smthrs/flow` hands an AST that crossed a serialization boundary back as a node. The `TypeId` marker is a public string any object can carry and counts for nothing on its own. Every combinator that admits a node reads its `ast` as trusted topology, so an object carrying the marker on any other prototype, one inheriting it from a node, and one whose `ast` is missing, malformed, or cyclic are all refused with the same `GraphBuildError` as any other non-node. A proxy is judged by the shape it forwards.

The functions an author writes, a mapper, a continuation, a branch predicate, live in `WeakMap`s keyed by the AST node they belong to, and the AST keeps only a `FunctionIdentity` digest of the function's exact source. Exact source matters, because whitespace inside a string literal is behavior. A function whose inert captures were declared with `capture` digests those captures; every other function additionally carries process-local, per-function entropy, so indistinguishable closure sources fail closed instead of sharing a cache key. `capture` refuses a capture record nested past 256 levels with a path-bearing error rather than overflowing the native stack.

The `@category engine` members of this module, `flowCall`, `actionCall`, `declaration`, `continuation`, `mapper`, `predicate`, `catchFilter`, and `functionIdentity`, exist for [`@smthrs/flow`](/api/flow). They are supported names, not authoring API.

## Planned

[src/Planned.ts](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/plan/src/Planned.ts)

A planned value may be passed into a payload field, into a branch, or into a map, and field access is allowed, because it records a reference path.

:::danger
A planned value may never be computed on.
:::

Misuse fails twice. The type is branded, so arithmetic and template interpolation are compile errors; and the proxy's `Symbol.toPrimitive`, `valueOf`, `toString`, `toJSON`, application, `in`, and enumeration traps throw rather than let a plan be built around `NaN` or `"[object Object]"`. JavaScript exposes no trap for `Boolean(value)` or strict identity, so those cannot be refused at run time; they reveal only proxy truthiness or identity and never the planned result.

The `TypeId` symbol is interned, so a value that crossed a module boundary is still recognised. Interning is a recognition aid rather than a capability, so `reference` returns a reference only when the value stored under that symbol has the complete `{node, path}` shape.

## FileSet

[src/FileSet.ts](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/plan/src/FileSet.ts)

The static filesystem declaration vocabulary shared by planning and execution: a workspace-relative `Pattern`, a Bazel-style `Glob`, a `TreeArtifact`, and the `Filegroup` that names a reusable collection.

`canonical` rewrites every separator to `/` and normalizes to Unicode NFC, and every exact-path comparison goes through it, so the backslash spelling and the NFD spelling of one workspace path overlap. `workspaceRelative` refuses absolute paths, drive letters, `..` and `.` segments, empty segments, the C0 control range, and DEL. C1 bytes stay legal, because a POSIX file name may contain them.

`overlaps` is conservative: `true` may over-serialize, while `false` proves that no path can belong to both declarations.

## GraphBuildError

[src/GraphBuildError.ts](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/plan/src/GraphBuildError.ts)

The refusals a plan-time build raises instead of producing a wrong plan. Each carries the site, `node` plus the recorded property `path`, and states the fix in `message`, because the author reading it is mid-body.

| `code`                        | Meaning                                                                                        |
| ----------------------------- | ---------------------------------------------------------------------------------------------- |
| `planned_value_computed`      | a body computed on a step result                                                               |
| `invalid_all_member`          | `Node.all` received a non-node member                                                          |
| `invalid_continuation`        | a branch arm, catch arm, or continuation did not return a node                                 |
| `recursion_requires_boundary` | a flow calls itself inline instead of using a trampoline handoff or an explicit child boundary |
| `placement_requires_boundary` | an inline call's callee declares a placement the enclosing flow cannot satisfy                 |
| `cyclic_payload`              | a payload contains itself, so no plan could serialize or hash it                               |
| `payload_too_deep`            | a payload is nested past the build bound                                                       |
| `graph_too_deep`              | authored topology is nested past the build bound                                               |
| `duplicate_node`              | two structural graph addresses resolve to one durable node id                                  |
| `invalid_priority`            | `Node.priority` received a value that is not a safe integer                                    |
| `invalid_payload`             | a payload member cannot be captured as inert JSON without executing code or losing identity    |

`GraphBuildErrorCode` is a closed schema literal, so a caller may switch on it and a new refusal is a deliberate addition rather than a new free-form string.

## PlanDiff

[src/PlanDiff.ts](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/plan/src/PlanDiff.ts)

The verdict is the key: two nodes with the same id and the same key are the same step. The attribution, `changed: ["body", "input[1]"]`, is a report for a human, derived by comparing declarations field by field, and is deliberately part of no digest. Labels mirror the fields the hashed material body folds: `body`, `layers`, `capabilities`, `effects`, `version`, `nondeterministic`, `placement`, and `input[n]`, including `input[n]` entries whose declaration is unchanged but whose referenced node itself re-keyed. A node re-keyed purely by an upstream edit is therefore attributed to the input position that references it, even behind an unprojected `Pending`, rather than reported as nothing changed.

Each compared field is projected through the same JSON mirror the keys are derived from, so two `Date` bodies a generation apart attribute to `body` rather than to nothing. The projection runs no accessor, and a field it refuses compares by an identity token scoped to that node and field, so `diff` stays a total function even for a value canonical serialization would reject.

## PlanStore

[src/PlanStore.ts](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/plan/src/PlanStore.ts)

`record` is first-writer-wins in the shape `CacheStore.put` established: an identical re-record is not an error, and a different plan under the same id is a `Conflict` carrying the stored digest rather than a silent overwrite. It accepts generation 0 only, whose `baseDigest` equals its `digest` and every one of whose nodes is at generation 0. `get` returns the whole plan with nodes in recorded order.

`append` advances the plan row with a compare-and-swap on the previous generation, the flow, and the approved base digest, and refuses an append that adds no nodes. The refusal matters because of the append-only triggers: without it the node rows would land while the plan-row update matched nothing or skipped a generation, leaving rows whose dependencies are missing and that nothing is allowed to delete. The whole append is one transaction, so the refusal takes the rows back with it. Ordinals are derived from the rows already stored, not from the caller's array.

Every failure is a `PlanStoreError` whose `code` is one of `invalid_plan`, `constraint`, `decode_failed`, `persistence_failed`, or `unknown`.

## Migrations

[src/Migrations.ts](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/plan/src/Migrations.ts)

The namespaced set owns `flows_plans`, `flows_plan_nodes`, and `flows_plan_edges` in id block `4000`. Block `4000` is the next free block after the journal (`0`), the run store (`1000`), the step cache (`2000`), and the engine store (`3000`). [`@smthrs/engine-store`](/api/engine-store)'s `Migrations.sets` composes this set last, because `Migrator` decides what to run from a single high-water mark and a set whose ids sit below an already-applied one would be assumed done.

The ordered steps live under `src/internal/migrations`, which the export map blocks, so `set` is the only way to reach them; a step imported on its own would run outside the namespaced ordering `Migrator` relies on.

Append-only is enforced in SQL rather than by convention. `0001_initial` creates the tables, the `flows_plan_nodes_order` index, and triggers that raise on any UPDATE or DELETE of `flows_plan_nodes` and `flows_plan_edges` and on any backward move of a `flows_plans` row. `0002_append_only_hardening` forbids deleting a plan row, extends the forward-only trigger to pin `flow` and `created_at_ms`, and makes `(plan_id, ordinal)` unique so recorded node order is deterministic.
