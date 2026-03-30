# Proposed PR Title

feat(graph): expose plan tree helpers via smithers-orchestrator/graph

# Proposed PR Body

## Problem

Smithers already exposes `renderFrame()`, which gives external tooling access to the rendered workflow XML and flattened task list, but it did **not** expose the XML-to-plan conversion the runtime actually uses for scheduling.

That left a gap for graph tooling:

- external consumers could get `xml`, but had to reimplement Smithers scheduling semantics themselves
- visualizers and workflow builders had no supported way to derive the runtime plan tree
- consumers had to either duplicate internal tag-mapping logic or depend on private module paths
- the docs did not show a clean path for building graph inspectors or n8n-style node editors on top of Smithers

## What this PR adds

### Minimal `/graph` subpath

Adds a dedicated public subpath:

- `smithers-orchestrator/graph`

It re-exports the existing runtime helper and types:

- `buildPlanTree`
- `PlanNode`
- `RalphMeta`

This keeps the change intentionally small. It does **not** introduce a new graph model, new scheduler APIs, or a new editor abstraction.

### Package wiring

Adds subpath export wiring in:

- `package.json`
- `tsconfig.json`

Including back-compat path mapping for:

- `smithers-orchestrator/graph`
- `smithers/graph`

### Documentation for graph tooling

Adds a new doc page:

- `docs/runtime/graph.mdx`

The docs show how to:

1. call `renderFrame()`
2. pass `snapshot.xml` into `buildPlanTree()`
3. walk the resulting `PlanNode` tree
4. build a `nodes[]` / `edges[]` representation for external UIs

This is aimed at:

- graph inspectors
- React Flow canvases
- custom DAG visualizers
- n8n-style workflow builders implemented outside Smithers itself

Also updates `docs/runtime/render-frame.mdx` and the README to point users at the new `/graph` subpath.

## Why this approach

The goal here is to unlock graph tooling with the fewest new public commitments.

This PR intentionally does **not**:

- export `scheduleTasks`
- expose task state-map internals
- add a new stable graph node/edge schema
- add UI/editor code inside Smithers

Instead, it exposes the existing XML-to-plan conversion behind a dedicated graph-focused entry point.

That gives external tooling a supported way to stay aligned with Smithers runtime semantics, while keeping the public surface area small and avoiding a larger API design decision before real consumers exist.

## Validation

### Automated

Verified with targeted tests after `bun install`:

- [x] `bun test tests/graph-subpath.test.ts tests/scheduler-comprehensive.test.ts tests/worktree-plan.explicit.test.ts tests/nested-ralph-bug.test.ts`

This covers:

- subpath import resolution
- `buildPlanTree` export availability
- core plan tree behavior
- Ralph loop plan handling
- worktree / merge-queue plan handling
- nested Ralph edge cases

### Manual usage verification

Also verified the intended consumer flow directly:

1. import `renderFrame` from `smithers-orchestrator`
2. import `buildPlanTree` from `smithers-orchestrator/graph`
3. render a sample workflow
4. convert `snapshot.xml` into a `PlanNode` tree

Confirmed that the plan tree is returned correctly for the new public subpath.

## Scope

Included in scope:

- `/graph` subpath export
- package/path wiring
- docs for graph-based tooling
- targeted test coverage

Not included:

- a new stable node/edge graph contract
- scheduler replay APIs
- live server `/graph` endpoints
- any workflow builder UI inside Smithers

## Notes

This is meant to be the smallest clean step that satisfies the graph-visualization use case discussed in issue #90 while preserving room to design a richer graph contract later if external tooling proves out the need.
