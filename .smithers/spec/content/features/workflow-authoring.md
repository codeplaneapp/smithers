# JSX workflow authoring

> **Status:** Fixed | **Priority:** P0 | **Owner:** smithers-maintainers | **Group:** Author workflows

Author durable coding-agent workflows as React/JSX trees with Workflow, Task, Sequence, Parallel, Branch, Loop, Approval, HumanTask, Timer, Sandbox, Worktree, and higher-level components, backed by createSmithers and zod-typed outputs.

## What you can do

Write a multi-step agent plan as a typed TSX file, compose it from reusable workflow components, and let persisted state drive the next render.

## Capabilities

### Typed outputs

createSmithers binds zod/v4 schemas to task outputs and deps.

### Control flow

Sequence, Parallel, Loop with until/maxIterations, Branch, conditional rendering.

### Compute nodes

Function children run real shell/git work inside the durable graph.

### Typed workflow factory

createSmithers returns Workflow, smithers, outputs, and table helpers bound to zod schemas.

### React control flow

Workflow plans are rendered by the React reconciler; Sequence, Parallel, Branch, Loop, and conditional mounting shape scheduling.

### Human and external waits

Approval, HumanTask, Signal, WaitForEvent, and Timer model durable pauses without keeping a process alive.

### Higher-level patterns

Components export review loops, supervisors, kanban, merge queues, sagas, panels, delegation chains, and other workflow macros.

## Endpoints and commands

- `API createSmithers(schemas, options)` ([docs](docs/jsx/overview.mdx))
- `CLI smithers graph <workflow>` ([docs](docs/cli/overview.mdx))
- `CLI smithers workflow create` ([docs](docs/workflows/make-workflow-tutorial.mdx))

## Related docs

- [How it works](docs/how-it-works.mdx)
- [Execution model](docs/concepts/execution-model.mdx)
- [Components](docs/components/workflow.mdx)

## Test cases

- `packages/engine/tests/engine-workflow.test.jsx`
- `packages/engine/tests/engine-scheduler-plan.test.js`
- `packages/engine/tests/duplicate-output-schemas.test.jsx`
- `packages/driver/tests/ctx-utils.test.js`
- `apps/cli/tests/cli-workflows-validate.test.js`
- `apps/cli/tests/seeded-workflows-graph.e2e.test.js`

## Observability

- Frame snapshots and task descriptors are persisted in \_smithers\_\* tables and can be inspected with smithers graph, inspect, tree, and DevTools streams.
- Task attempts emit run events and node state transitions consumed by the CLI, gateway, and custom UIs.

## Debugging

- Run smithers graph <workflow> to inspect the rendered task plan before executing.
- Use `smithers inspect` <runId>, `smithers output` <runId> <nodeId>, and `docs/how-it-works.mdx` to debug ctx/output reads and conditional mounting.

## Architecture

- `packages/smithers/src/index.js` re-exports createSmithers plus all component primitives from @smithers-orchestrator/components.
- `packages/components/src/index.js` exports prompt rendering, zod examples, and component host elements; `packages/engine/src/index.js` and `packages/driver/src/index.js` run the rendered graph.
- `docs/how-it-works.mdx` documents the render -> extract -> schedule -> execute -> persist -> re-render loop.

## Fixes and diffs

- 2026-07-06 refresh: read README.md, package exports, selected package entry points, `docs/how-it-works.mdx`, `docs/cli/overview.mdx`, `docs/agents/overview.mdx`, `docs/integrations/custom-ui.mdx`, `docs/integrations/mcp-server.mdx`, `docs/deployment/production-hardening.mdx`, `docs/deployment/control-plane.mdx`, and targeted test inventories.
- 2026-07-06 review: `bun test` --timeout=120000 --max-concurrency=1 for the six listed workflow-authoring test files passed.
- `packages/smithers/src/create.js`
- `packages/components/src/components/Task.js`
- `packages/react-reconciler/src`
- `packages/graph/src/extract.js`
- `docs/components/*.mdx`
- `.smithers/workflows/*.tsx`
