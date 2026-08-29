# @smthrs/plan

The persisted plan: a keyed action graph, its append-only store, its diff, and
the step-key compiler that gives every node its identity.

A plan is "a `Node` graph with every key computed, produced by the plan phase
and inert until run". This package is that value made durable — and nothing
more. It performs no I/O beyond the database and never executes anything;
driving a plan is `@smthrs/engine-store`'s `PlanScheduler`.

```ts
import { Plan, PlanStore } from "@smthrs/plan"
import * as Effect from "effect/Effect"

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
```

## What is in here

| Module        | Role                                                                                                 |
| ------------- | ---------------------------------------------------------------------------------------------------- |
| `KeyMaterial` | What a planner declares about a node: body, tagged input references, layers, capabilities, effects   |
| `StepKey`     | The compiler that turns material plus resolved dependency digests into an `@smthrs/keys` `Key`       |
| `Plan`        | `compile`, `append`, the node/edge/conflict schemas, and the digest an approval binds to             |
| `PlanDiff`    | `smithers plan --diff` as a value: added, removed, re-keyed (with attribution), unchanged            |
| `PlanStore`   | Append-only SQL persistence — migration block `4000`, enforced by triggers rather than by convention |
| `Migrations`  | The namespaced migration set, composed by `@smthrs/engine-store`'s `Migrations.sets`                 |

## The four rules this package exists to keep

**Planning demands nothing.** A `Node` carries Effect's requirement channel,
`R`, and carries it as a phantom: no combinator here reads it, and the AST, the
graph, the key material, and every digest are identical whatever it says.
Building a plan therefore asks for no service at all. What fills the channel is
a call to something whose code lives elsewhere — an action — so a plan's type
states which implementations running it will need, and the place that runs it
(`Flow.execute`, in `@smthrs/flow`) is where the compiler asks for them.
Each combinator unions its parts: `all` over its members, `map` and `andThen`
along the chain, `branch` over BOTH arms and `catch` over its failure arm,
because both arms of a decision are topology the plan carries and a run has to
be able to take either.

**Planning performs no I/O.** Nothing here reads a file, a clock, or a network.
A node's declared `effects` carry read and write _paths_, never digests —
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
Growth implies something to grow: appending to a plan that was never recorded
is a `constraint` refusal, because the alternative is node rows for a plan that
does not exist and that the append-only triggers then forbid removing.

## Conflict annotations

Declared write sets make overlap detectable at plan time. `compile` annotates
both members of every overlapping pair that no dependency path already orders:

- `serialize` — the default; the later writer gains an ordering edge. The edge
  is **not** key material, so a serialized node keeps its cache hit.
- `lane` — both writers get lane annotations when either asks for one; no
  ordering edge, because the lanes run concurrently and merge back.
- `fail` — the compile fails, for flows that promise disjointness.

Each annotation also carries a runtime strategy — `delay-rebase` or
`stop-merge` — which is what the scheduler does when the predicted overlap
actually bites.

## Browser support

Browser-safe. The package resolves no `node:` built-in; `pnpm run browser` at the
repository root executes that claim.
