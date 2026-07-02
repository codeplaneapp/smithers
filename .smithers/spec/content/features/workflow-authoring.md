# JSX workflow authoring

> **Status:** Fixed · **Priority:** P0 · **Owner:** smithers-maintainers · **Group:** Author workflows

**What you can do:** Write a multi-agent plan as a small typed TSX file and run it durably.

Author durable workflows as JSX/TSX files (Workflow, Sequence, Parallel, Loop, Task, Approval, Branch, Worktree) with zod-typed outputs via createSmithers. Seeded init pack ships editable workflows under .smithers/workflows.

## Capabilities

### Typed outputs

createSmithers binds zod/v4 schemas to task outputs and deps.

### Control flow

Sequence, Parallel, Loop with until/maxIterations, Branch, conditional rendering.

### Compute nodes

Function children run real shell/git work inside the durable graph.




## Test cases

- pnpm -C packages/smithers test
- pnpm -C packages/engine test
- pnpm -C e2e test

## Observability

_None recorded yet._

## Debugging

_None recorded yet._

## Architecture

_None recorded yet._

## Fixes & diffs

_None recorded yet._

## Open gaps

_None recorded yet._

