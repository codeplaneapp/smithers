# @smthrs/flows-compile

Stage 1.2 of the flows migration
([`.smithers/specs/flows-migration.md`](../../.smithers/specs/flows-migration.md)).

Compiles a `GraphSnapshot` — what `@smthrs/graph`'s `extractGraph` produces from
a rendered workflow frame — into the three things the flows engine runs on: a
`@smthrs/plan` keyed action graph, the `@smthrs/flow` action declarations its
steps dispatch through, and a flow definition whose body is that graph.

```ts
import { compileGraphSnapshot, smithersNodes } from "@smthrs/flows-compile";

const compiled = compileGraphSnapshot(snapshot);
compiled.plan;                                   // the keyed action graph
compiled.flow;                                   // the flow definition
smithersNodes(compiled.flow).planNodeIdByNodeId; // node id the UI shows -> plan address
```

Compilation is pure. It hashes and does nothing else: no filesystem, no clock,
no network. That is the plan-phase law `@smthrs/plan` is written against, and it
is what makes the golden snapshots in `tests/goldens` reproducible.

## How a task compiles

| Smithers task | flows |
| --- | --- |
| agent | a harness `AgentStep` action (`smithers/agent`) |
| compute | an action whose body runs the `computeFn` (`smithers/compute`) |
| human | the compute family under its own tag (`smithers/human`) |
| static | a sealed constant step (`smithers/static`) |

`<Task sideEffect>` picks the action's durability tier. No declaration is
`sealed`; a declared `revert` is `compensable`; a declared effect with no undo
is `irreversible`, whether or not the author called it idempotent — idempotence
makes a retry safe, it does not make an effect reversible. The tier is part of
the dispatch tag (`smithers/agent.irreversible`) because a flows action declares
one tier and an implementation table resolves by tag.

`implementationLayers(compiled)` wires the compute, human, and static bodies.
Agent steps have no layer here: an `AgentStep` is run by the harness, which is
stage 1.4's work.

## Edges

`needs` — which `<Task deps>` resolves into — is a value dependency and becomes a
`Ref`. `dependsOn` and `fork` say only "not before" and become `Pending`. Both
become plan edges, and `@smthrs/plan` derives the edge set from exactly these
references, so an edge and a hashed reference can never disagree.

A dependency the frame does not contain is reported in `diagnostics` rather than
thrown: a partially rendered frame is a real state, and the rest of its topology
is still worth inspecting. A cycle is fatal.

## Identity

A step's identity is the flows content hash, `PlanNode.key`. Smithers node ids
are lookup addresses: they ride along as flow annotations
(`smithersNodes(compiled.flow)`), so the gateway, the UI, and the CLI keep
addressing nodes by the ids they already show, and renaming a task does not
re-key it.

Two exceptions are deliberate.

- **Compute and human steps are pinned to their node id.** A `computeFn` is a
  closure, and JavaScript cannot inspect what a closure captured, so the
  function's source digest alone does not identify what it will compute. Pinning
  costs a cache hit on a rename and prevents a wrong one on a capture.
- **A loop iteration re-keys.** A `<Loop>` body re-renders with the same node id
  each round, so the iteration is content: without it, round 2 would cache-hit
  round 1.

Pure scheduling knobs stay out of the key — `parallelGroupId`,
`parallelMaxConcurrency`, the `subtree*` caps, and `failurePolicy`.
`@smthrs/plan` keeps ordering edges out of a key for the reason that covers all
of them: the same work in a different concurrency group computes the same
result. `priority` reaches the plan as `NodeDraft.priority`, which the plan
digest covers and the step key does not.

Values a canonical JSON serializer cannot hold — closures, zod schemas, drizzle
tables — are replaced by a digest marker before hashing, so they still
contribute to identity without the serializer having to represent them. A zod
output schema contributes its top-level field names: an added or removed column
re-keys, a change confined to one field's validator does not.

## Tests

```sh
pnpm -C packages/flows-compile test
UPDATE_GOLDENS=1 pnpm -C packages/flows-compile test   # re-record the goldens
```

`tests/fixtures` are host trees, which is what the React reconciler hands
`extractGraph` in production, and they go through the real `extractGraph`. The
set mirrors the shapes `e2e/parity/fixtures` drives: a linear chain, a fan-out
and merge, an approval gate, side-effect tiers, and a loop iteration.
`tests/goldens` holds one committed plan per fixture. Re-record only when a
compilation change is intended, and review the diff — a golden diff is the only
signal that a step key moved.

The cross-engine gate is `e2e/parity`, which compares durable behaviour between
engines. These goldens gate the compilation itself, which parity cannot see.

## Importing flows

flows is consumed under the `@flows/*` aliases, never the bare `@smthrs/*`
names: nine names exist in both trees and the bare name means this workspace.
The aliases are declared by `vendor/flows`, a pnpm-only workspace package, and
public-hoisted by `.npmrc`. They are deliberately absent from this manifest,
because bun has no version-scoped override and a bun-visible flows edge would
take over the workspace package of the same name. See `vendor/flows/README.md`.
