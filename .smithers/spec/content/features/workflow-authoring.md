# JSX workflow authoring

> **Status:** Fixed | **Priority:** P0 | **Owner:** smithers-maintainers | **Group:** Author workflows

Author durable agent workflows as typed `React/JSX` trees with control flow, waits, memory, isolation, reusable composites, and bounded dynamic Trellis delegation. createSmithers binds Zod outputs and task dependencies to the workflow context.

## What you can do

Write a multi-step agent plan as a typed TSX file, compose it from reusable workflow components, and let persisted state drive the next render.

## Capabilities

### Typed outputs

createSmithers binds `zod/v4` schemas to task outputs and deps.

### Control flow

Sequence, Parallel, Loop with `until/maxIterations`, Branch, conditional rendering.

### Compute nodes

Function children run real `shell/git` work inside the durable graph.

### Typed workflow factory

createSmithers returns Workflow, smithers, outputs, and table helpers bound to zod schemas.

### React control flow

Workflow plans are rendered by the React reconciler; Sequence, Parallel, Branch, Loop, and conditional mounting shape scheduling.

### Human and external waits

Approval, HumanTask, Signal, WaitForEvent, and Timer model durable pauses without keeping a process alive.

### Higher-level patterns

Components export review loops, supervisors, kanban, merge queues, sagas, panels, delegation chains, and other workflow macros.

### Scheduling and failure controls

Task and container props cover priority scheduling, halt or quarantine failure policy, typed dependencies, bounded schema correction, retries, timeouts, and caching.

### Dynamic delegation

Trellis validates and compiles fuel-bounded model-authored sequence and parallel programs into ordinary durable tasks.

## Endpoints and commands

- `API createSmithers(schemas, options)` ([docs](docs/jsx/overview.mdx))
- `CLI smithers graph <workflow>` ([docs](docs/cli/overview.mdx))
- `CLI smithers workflow create` ([docs](docs/workflows/make-workflow-tutorial.mdx))

## Related docs

- [How it works](docs/how-it-works.mdx)
- [Execution model](docs/concepts/execution-model.mdx)
- [Components](docs/components/workflow.mdx)
- [Trellis](docs/components/trellis.mdx)
- [Provenance](docs/concepts/provenance.mdx)

## Test cases

- `packages/engine/tests/engine-workflow.test.jsx`
- `packages/engine/tests/engine-scheduler-plan.test.js`
- `packages/engine/tests/duplicate-output-schemas.test.jsx`
- `packages/driver/tests/ctx-utils.test.js`
- `apps/cli/tests/cli-workflows-validate.test.js`
- `apps/cli/tests/seeded-workflows-graph.e2e.test.js`
- `packages/components/tests/delegation-v2-trellis.test.jsx`
- `packages/components/tests/memory-component.test.jsx`
- `packages/components/tests/priority-props.test.jsx`
- `packages/components/tests/failure-policy-props.test.jsx`
- `packages/engine/tests/schema-retries.test.jsx`

## Observability

- Frame snapshots and task descriptors are persisted in \_smithers\_\* tables and can be inspected with smithers graph, inspect, tree, and DevTools streams.
- Task attempts emit run events and node state transitions consumed by the CLI, gateway, and custom UIs.

## Debugging

- Run smithers graph <workflow> to inspect the rendered task plan before executing.
- Use `smithers inspect` <runId>, `smithers output` <runId> <nodeId>, and `docs/how-it-works.mdx` to debug `ctx/output` reads and conditional mounting.

## Architecture

- `packages/smithers/src/index.js` re-exports createSmithers plus all component primitives from @smithers-orchestrator/components.
- `packages/components/src/index.js` exports prompt rendering, zod examples, and component host elements; `packages/engine/src/index.js` and `packages/driver/src/index.js` run the rendered graph.
- `docs/how-it-works.mdx` documents the render -> extract -> schedule -> execute -> persist -> re-render loop.

## Fixes and diffs

- 2026-07-06 refresh: read README.md, package exports, selected package entry points, `docs/how-it-works.mdx`, `docs/cli/overview.mdx`, `docs/agents/overview.mdx`, `docs/integrations/custom-ui.mdx`, `docs/integrations/mcp-server.mdx`, `docs/deployment/production-hardening.mdx`, `docs/deployment/control-plane.mdx`, and targeted test inventories.
- 2026-07-06 review: `bun test --timeout`=120000 --max-concurrency=1 for the six listed workflow-authoring test files passed.
- 2026-07-18 feature and docs audit: added Memory, Trellis, priority, quarantine, schema-correction, and provenance surfaces to the inventory and Mintlify references.
- `packages/smithers/src/create.js`
- `packages/components/src/components/Task.js`
- `packages/react-reconciler/src`
- `packages/graph/src/extract.js`
- `docs/components/*.mdx`
- `.smithers/workflows/*.tsx`
- `packages/smithers`
- `packages/components`
- `packages/graph`
- `packages/react-reconciler`
