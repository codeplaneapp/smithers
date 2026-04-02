# PR Title

feat(graph): expose plan tree via smithers-orchestrator/graph and add visual workflow builder sample

# PR Body

Closes #90

## Problem

Smithers constructs an internal scheduling DAG via `buildPlanTree()` in `src/engine/scheduler.ts`, but this function and its types are not exported. External consumers who want to visualize or analyze workflow graphs are left with two incomplete options:

1. The flat `tasks` array from `renderFrame()` — no edges, no dependency information.
2. The raw `xml` tree — requires reimplementing the XML-to-plan conversion that `buildPlanTree` already does.

The actual graph that Smithers uses to schedule execution — the `PlanNode` tree — is the only representation that cleanly encodes task dependencies, parallel groups, and loop semantics. But it's internal.

## What this PR adds

### 1. `smithers-orchestrator/graph` subpath export

A minimal new subpath that re-exports the existing runtime helper and types:

```ts
export { buildPlanTree } from "../engine/scheduler";
export type { PlanNode, RalphMeta } from "../engine/scheduler";
```

This is zero new implementation code — just making existing internals available through a dedicated graph-focused entry point.

**Files:**
- `src/graph/index.ts` — 2 lines
- `package.json` — 1 line (subpath export)
- `tsconfig.json` — 2 lines (path aliases)

### 2. Documentation

Adds `docs/runtime/graph.mdx` explaining:
- what `/graph` exports
- how to combine `renderFrame()` with `buildPlanTree()`
- how to derive `nodes[]` and `edges[]` for external graph tooling
- a complete example of building an n8n-style UI-friendly graph from the plan tree

Updates `docs/runtime/render-frame.mdx` and `README.md` to point users at the new subpath.

### 3. Visual workflow builder sample

Adds `examples/graph-builder/` — a fully in-browser visual workflow editor that demonstrates what external tooling can build on top of `/graph`.

The sample is a single self-contained HTML file with:
- node graph canvas with SVG edges, handles, and labeled connections
- support for agent, shell, approval, parallel, loop, and branch nodes
- drag-to-move node positioning
- zoom controls, fit view, horizontal/vertical orientation toggle
- minimap
- collapsible inspector panel with prompt, schema, and config editing
- generated Smithers TSX code preview
- runtime plan tree preview via `buildPlanTree` (inlined as pure browser JS)
- browser file picker for importing graph JSON or workflow TSX
- client-side TSX text parser for importing existing workflows
- graph JSON export for stable round-trip editing

**No server, no API, no dependencies.** Open the HTML file in any browser. `buildPlanTree` and all its dependencies are inlined as pure functions.

### 4. Test

Adds `tests/graph-subpath.test.ts` verifying that `buildPlanTree` is importable and functional from `smithers-orchestrator/graph`.

## Why this approach

The issue discussion considered several options. This PR takes the most minimal path:

- **Does not** export `scheduleTasks` or state-map internals
- **Does not** introduce a new stable graph node/edge schema
- **Does not** add server endpoints or CLI flags
- **Does not** add new Smithers core dependencies

It exposes the existing XML-to-plan conversion behind a dedicated subpath, keeping the public surface small. The sample proves the API is sufficient for building rich external graph tooling without adding anything else to Smithers core.

If external consumers prove out the need for a richer stable graph contract (e.g. explicit `nodes/edges` types), that can be added later on the same subpath without breaking what's here.

## Validation

### Automated

```bash
bun test tests/graph-subpath.test.ts tests/scheduler-comprehensive.test.ts tests/worktree-plan.explicit.test.ts tests/nested-ralph-bug.test.ts
```

47 tests pass, 0 failures. Covers:
- subpath import resolution
- `buildPlanTree` export availability
- core plan tree behavior
- Ralph loop plan handling
- worktree / merge-queue plan handling
- nested Ralph edge cases

### Manual

- verified `smithers-orchestrator/graph` resolves correctly via `bun -e`
- verified the graph builder sample loads from `file://` with zero server
- verified TSX import of `examples/simple-workflow.tsx` and `examples/code-review-loop.tsx` via the in-browser text parser
- verified plan preview runs `buildPlanTree` entirely client-side
- verified generated Smithers TSX is syntactically valid

## Files changed

| File | Change |
|------|--------|
| `src/graph/index.ts` | New — 2-line re-export |
| `package.json` | Add `./graph` subpath export |
| `tsconfig.json` | Add path aliases for `smithers/graph` and `smithers-orchestrator/graph` |
| `docs/runtime/graph.mdx` | New — graph subpath documentation |
| `docs/runtime/render-frame.mdx` | Cross-reference to `/graph` |
| `README.md` | Brief graph tooling note |
| `tests/graph-subpath.test.ts` | New — subpath import test |
| `examples/graph-builder/index.html` | New — self-contained visual builder |
| `examples/graph-builder/README.md` | New — sample readme |
