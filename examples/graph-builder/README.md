# Smithers Graph Builder

A fully in-browser visual workflow editor for Smithers. No server required.

One self-contained HTML file. Open it directly or host it anywhere.

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

Open `index.html` in any browser. That's it.

```bash
open examples/graph-builder/index.html
```

Or host it on any static file server, CDN, or paste it into a gist.

## How it works

Everything runs in the browser:

- `buildPlanTree` from `smithers-orchestrator/graph` is inlined as a pure function
- TSX import uses a client-side text parser that extracts Smithers component structure
- graph editing, code generation, plan preview — all client-side JS
- no fetch calls, no API, no server, no dependencies

## Server mode (optional)

The `server.ts` file is still available for local development with richer features:
- Smithers-rendered TSX import via `renderFrame()`
- local filesystem load/save with validation
- nearby workflow discovery

Run it with:
```bash
cd examples/graph-builder
bun run server.ts
```
