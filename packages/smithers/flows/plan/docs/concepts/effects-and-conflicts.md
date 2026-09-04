---
title: "Declared effects and conflicts"
description: "How declared reads and writes become ordering: the overlap pass, the reader-after-writer pass, the three verdicts, and the cycles both passes refuse."
sidebar:
  order: 3
---

Every node declares what it does to the workspace, as paths. Two plan-time
passes read those declarations and turn them into edges, so a scheduler never
has to guess whether two pieces of work can run at once.

```ts
import * as Plan from "@smthrs/plan/Plan"

const effects: Plan.NodeEffects = {
  reads: ["src/**/*.ts"],
  writes: ["dist/bundle.js"],
  removes: ["dist/stale.js"],
  boundaryMode: "hard"
}
```

Paths only. Measuring a path is run-time work, so a digest here would break the
no-I/O law that makes a plan reproducible.

## What a node produces

`removes` is optional, and a removal mutates the world exactly as a write does.
Both passes therefore fold `writes` and `removes` into one produced set. A path
declared as both is refused as `invalid_effects`, because the declaration
contradicts itself.

`boundaryMode` is `hard` or `expected`. It travels with the declaration into the
measured boundary at execution time; the plan passes do not interpret it.

## The overlap pass

Declared write sets make overlap detectable before anything runs. The pass
compares every pair of producing nodes and skips a pair the graph already
orders, including one ordered through an ordering edge this same pass just
inferred. Every other overlapping pair is annotated on both members with the
resolved verdict.

| Verdict     | Effect                                                                            |
| ----------- | --------------------------------------------------------------------------------- |
| `serialize` | The default. The later writer gains an ordering edge.                             |
| `lane`      | Both writers get lane annotations when either asks for one, and no ordering edge. |
| `fail`      | `compile` fails with `overlap_forbidden`, for flows that promise disjointness.    |

`fail` dominates `lane`, which dominates `serialize`. A flow that promised
disjointness must not be quietly serialized, and a pair where either side asked
for a lane must not be silently ordered.

Each annotation also carries the runtime strategy the pair resolved to, where
`stop-merge` dominates `delay-rebase`. That is what the scheduler does when the
predicted overlap actually bites.

A node states its own preferences on its draft, through `conflictStrategy` and
`runtimeStrategy`. The annotation is a property of the _pair_, not of one
declaration, which is why both preferences are recorded on the node and resolved
per pair.

Nodes frozen by an earlier generation are annotated on the new node only,
because their rows are append-only.

## The reader-after-writer pass

The overlap pass compares write sets against write sets, so a node that _reads_
a path another node _writes_ is ordered by nothing. Reader and writer could be
admitted in the same wavefront round; the reader would then measure pre-producer
bytes and, because the dispatch key honestly folds the digest it measured, cache
that wrong execution as a legitimate one.

The second pass closes that. A reader whose read set overlaps a producer's
produced set gains an ordering edge to the producer, unless the graph already
orders it there.

Like a `serialize` edge, the edge enters `dependsOn` and never key material. The
reader computes the same result either way, and its content dependence is
already keyed by the hermetic boundary digests measured at dispatch.

## When an edge would close a cycle

If the graph already orders the writer _after_ the reader, through a declared
dependency or a serialize edge, no edge set satisfies both requirements. Adding
the reader-first edge closes a cycle; leaving it out lets the reader measure
pre-producer bytes. The plan is refused with `cycle`, and the message names the
reader, the overlapping paths, the producer, and the dependency chain that
contradicts it:

```text
Plan cycle: node lint reads dist/bundle.js, which node bundle produces, so lint must
follow bundle, but bundle already depends on lint through bundle -> report -> lint
```

Reachability decides this rather than plan order, because plan order only
justifies edges that point backwards, and a writer-first edge points either way.

## Overlap is conservative

`FileSet.overlaps` answers `true` whenever two declarations _might_ share a
path. Over-serializing costs latency; under-serializing costs correctness, so
the comparison is deliberately asymmetric: `false` proves that no path can
belong to both declarations.

Two globs always overlap, and so do a glob and a tree artifact, because
comparing pattern languages exactly is not worth the risk of being wrong.

Exact paths compare in canonical form: every separator rewritten to `/` and
Unicode normalized to NFC. Without that, `dist\bundle.js` and `dist/bundle.js`
would be two spellings of one file that the overlap check could not see, which
is the same class of hole that `.` segments and empty segments would open.
[Declare the files a node touches](../guides/declare-file-effects.md) covers the
vocabulary and the forms `workspaceRelative` refuses.

## What this buys the scheduler

A plan arrives at the scheduler with every predictable conflict already
resolved into an edge or an annotation. Two nodes with no path between them and
no annotation between them are safe to run at once, and that fact was
established before a single byte was read.

The annotations that remain describe the cases a plan cannot resolve alone: two
lane writers that a runtime has to keep apart, and the runtime strategy each
pair agreed on if the predicted overlap turns real.
