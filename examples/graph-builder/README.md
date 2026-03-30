# Smithers Graph Builder Sample

A minimal visual workflow editor sample built on top of:

- `renderFrame()` for workflow rendering
- `smithers-orchestrator/graph` for XML → plan conversion

## Why this exists

This sample is intentionally small and self-contained.

It demonstrates a low-surface-area approach to a node-based Smithers builder without adding new runtime/editor APIs to Smithers core or embedding the feature into Burns.

## What it does

- lets you add and edit a richer set of node types
  - agent prompt
  - shell command
  - approval gate
  - parallel block
  - bounded review loop
  - branch
- visualizes the workflow as a node graph with
  - labeled edges
  - branch fan-out
  - loop-back edges
  - zoom controls
  - horizontal / vertical reorientation
  - a minimap
- edits prompts, output keys, schemas, commands, loop settings, and branch conditions inline
- exports both
  - `workflow.graph.json`
  - `workflow.tsx`
- supports loading local workflows from
  - `workflow.graph.json`
  - `workflow.tsx`
  - a directory containing those files
- supports uploading graph JSON or a self-contained workflow TSX file manually
- validates generated code through Smithers before local save
- uses `buildPlanTree()` from `smithers-orchestrator/graph` to show the runtime plan tree

## Stability model

The builder is intentionally **graph-first**.

- If a `workflow.graph.json` sidecar exists, it is treated as the source of truth.
- Generated `workflow.tsx` is derived from that graph model.
- Loading an existing standalone `workflow.tsx` works as a **best-effort import** using Smithers rendering. This is useful for drafting and visualization, but it is not guaranteed to round-trip perfectly.

That split keeps editing stable and explicit while still letting the builder leverage Smithers to import existing workflows.

## Run

```bash
cd examples/graph-builder
bun run server.ts
```

Then open:

```txt
http://localhost:8787
```

## Notes

- The canvas is intentionally sequence-first to stay minimal.
- The generated code is a starting point, not a full round-trip authoring system.
- This sample is meant to validate the product direction with the least new surface area possible.
