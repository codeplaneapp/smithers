# @smithers/react — React Adapter Library Architecture Spec

> Internal engineering document. Defines the React adapter that bridges
> React's component model with `@smithers/core`.

## Overview

`@smithers/react` is a thin adapter library. It provides React components
(`<Task>`, `<Sequence>`, `<Parallel>`, etc.) and a React-based driver that
renders JSX into `HostNode` trees and feeds them to `@smithers/core`'s
`WorkflowSession` API. It owns the React reconciler, the render loop, and
re-rendering on state changes. It does NOT own scheduling, task execution,
persistence, or observability — those live in `@smithers/core`.

---

## Design Principles

1. **Thin adapter.** This package translates between React's world
   (components, reconciler, render cycles) and the core library's world
   (WorkflowGraph, EngineDecision). Business logic lives in the core.

2. **React owns rendering, core owns execution.** React decides what the
   workflow graph looks like at any point in time. The core library decides
   what to do with that graph. Neither calls into the other's internals.

3. **Components are syntax.** `<Task>`, `<Parallel>`, etc. are one-liner
   components that produce `HostElement` nodes. The real extraction logic
   lives in `@smithers/core`'s `extractGraph`.

4. **The driver is the bridge.** `ReactWorkflowDriver` is the single class
   that holds a `SmithersRenderer` and a `WorkflowSession`, wiring React's
   render output into the core's call-in API.

---

## Package Structure

```
@smithers/react/
  src/
    components/       # Task, Sequence, Parallel, Loop, Branch, etc.
    driver/           # ReactWorkflowDriver — the render-schedule loop
    reconciler/       # SmithersRenderer, React reconciler host config
    context/          # SmithersContext, buildContext
    prompts/          # renderPromptToText, MDX integration
    index.ts          # Public API
```

---

## Components

Each component is a thin wrapper that calls `React.createElement` with a
namespaced tag. Components do not contain logic — they are declarative
descriptions that the reconciler collects into a `HostNode` tree.

```ts
// Every component follows this pattern:

export function Sequence(props: SequenceProps) {
  if (props.skipIf) return null
  return React.createElement("smithers:sequence", props, props.children)
}

export function Parallel(props: ParallelProps) {
  if (props.skipIf) return null
  return React.createElement("smithers:parallel", {
    maxConcurrency: props.maxConcurrency,
    id: props.id,
  }, props.children)
}

export function Task<Row, Output, D extends DepsSpec>(props: TaskProps<Row, Output, D>) {
  // Validation, schema resolution, then:
  return React.createElement("smithers:task", resolvedProps, props.children)
}

// Loop, Branch, Worktree, Approval, Signal, Timer, Voice, etc.
// all follow the same pattern.
```

These components move from `smithers/src/components/` into this package
unchanged. They have zero dependency on `@smithers/core` — they produce
plain React elements.

---

## Reconciler

The React reconciler translates React's component tree into a plain
`HostNode` tree. This is the same custom reconciler that exists today in
`src/dom/renderer.ts`. It uses `react-reconciler` to implement a minimal
host config that builds `HostElement` / `HostText` nodes.

```ts
import { extractGraph, type HostNode, type WorkflowGraph } from "@smithers/core"

export class SmithersRenderer {
  private container: HostContainer
  private root: ReconcilerRoot

  async render(element: React.ReactElement, opts?: ExtractOptions): Promise<WorkflowGraph> {
    // 1. React reconciles the element tree into HostNodes
    updateContainerSync(element, this.root, null, () => {})
    flushSyncWork()

    // 2. Hand the HostNode tree to @smithers/core for extraction
    return extractGraph(this.container.root, opts)
  }
}
```

The key boundary: the reconciler produces `HostNode` (a type defined in
`@smithers/core`). Then it calls `extractGraph` (a function from
`@smithers/core`) to get a `WorkflowGraph`. The reconciler does not
interpret the tree — it just builds it and hands it off.

---

## ReactWorkflowDriver

This is the heart of the adapter. It implements the render → submit → respond
loop, translating between React's render lifecycle and the core's session API.

```ts
import {
  type WorkflowSession,
  type EngineDecision,
  type WorkflowGraph,
  createSession,
} from "@smithers/core"

interface ReactWorkflowDriverOptions {
  workflow: SmithersWorkflow
  runtime: ManagedRuntime       // from @smithers/core, driver provides layers
  db: SmithersDb
  runId: string
  rootDir: string
  // ... other run options
}

class ReactWorkflowDriver {
  private renderer = new SmithersRenderer()
  private session: WorkflowSession
  private runtime: ManagedRuntime

  constructor(opts: ReactWorkflowDriverOptions) {
    this.runtime = opts.runtime
    // session is created via the core library
  }

  async run(opts: RunOptions): Promise<RunResult> {
    // Initialize session
    this.session = await this.runEffect(createSession({ ... }))

    // Initial render
    let decision = await this.renderAndSubmit(opts)

    // Drive loop
    while (true) {
      switch (decision._tag) {
        case "Execute":
          decision = await this.executeTasks(decision.tasks)
          break

        case "ReRender":
          decision = await this.renderAndSubmit(decision.context)
          break

        case "Wait":
          decision = await this.handleWait(decision.reason)
          break

        case "ContinueAsNew":
          return await this.continueAsNew(decision.transition)

        case "Finished":
          return decision.result

        case "Failed":
          throw decision.error
      }
    }
  }

  // ── Private: React-specific rendering ──

  private async renderAndSubmit(context: RenderContext): Promise<EngineDecision> {
    // 1. Build React context from engine state
    const ctx = buildContext({
      runId: context.runId,
      iteration: context.iteration,
      iterations: context.iterations,
      input: context.input,
      outputs: context.outputs,
      auth: context.auth,
    })

    // 2. React renders the workflow JSX
    const graph = await this.renderer.render(
      this.workflow.build(ctx),
      {
        ralphIterations: context.iterations,
        defaultIteration: context.iteration,
        baseRootDir: this.rootDir,
      },
    )

    // 3. Submit the graph to the core engine
    return this.runEffect(this.session.submitGraph(graph))
  }

  // ── Private: Task execution ──

  private async executeTasks(tasks: TaskDescriptor[]): Promise<EngineDecision> {
    // Execute tasks concurrently, reporting results one by one
    const results = await Promise.allSettled(
      tasks.map(task => this.executeOneTask(task))
    )

    // The last taskCompleted/taskFailed call returns the next decision
    // In practice, the session handles the scheduling internally
    // and returns the next decision after all reported tasks are processed
    return this.runEffect(this.session.getNextDecision())
  }

  private async executeOneTask(task: TaskDescriptor): Promise<void> {
    try {
      const output = await this.runAgent(task)
      await this.runEffect(this.session.taskCompleted({
        nodeId: task.nodeId,
        iteration: task.iteration,
        output,
      }))
    } catch (err) {
      await this.runEffect(this.session.taskFailed({
        nodeId: task.nodeId,
        iteration: task.iteration,
        error: err,
      }))
    }
  }

  // ── Private: Effect escape (single boundary) ──

  private runEffect<A>(effect: Effect.Effect<A, any, any>): Promise<A> {
    return this.runtime.runPromise(effect)
  }
}
```

---

## How Re-rendering Works

Today the engine calls `renderer.render(workflowRef.build(ctx))` directly
when a loop iteration completes or the mounted task set changes. In the new
architecture:

1. Engine completes a loop iteration internally
2. Engine returns `{ _tag: "ReRender", context: { iteration: 3, ... } }`
3. **Driver** calls `this.renderAndSubmit(decision.context)`
4. React re-renders the JSX with the new context (iteration=3)
5. React's reconciler diffs the tree, produces new `HostNode`s
6. Driver calls `extractGraph()` on the new tree
7. Driver submits the new `WorkflowGraph` to `session.submitGraph()`
8. Engine returns the next decision

The engine never imports React. It just says "I need a fresh graph with this
context" and the driver figures out how to produce one.

```
Engine: "ReRender with iteration=3"
   ↓
Driver: workflow.build(ctx)  →  React reconciles  →  HostNode tree
   ↓
Driver: extractGraph(tree)   →  WorkflowGraph
   ↓
Driver: session.submitGraph(graph)  →  next EngineDecision
```

---

## SmithersWorkflow Type

This type stays in `@smithers/react` because it references `React.ReactElement`:

```ts
// @smithers/react — this is the React-specific workflow definition
type SmithersWorkflow<Schema> = {
  db: unknown
  build: (ctx: SmithersCtx<Schema>) => React.ReactElement
  opts: SmithersWorkflowOptions
  schemaRegistry?: Map<string, SchemaRegistryEntry>
  zodToKeyName?: Map<ZodObject<any>, string>
}
```

The core library has no concept of a "workflow definition." It only knows
`WorkflowGraph` — the output of rendering, not the rendering itself.

---

## Public API

```ts
// @smithers/react

// Components (JSX syntax for workflow definitions)
export { Task, Sequence, Parallel, Loop, Branch, Worktree } from "./components"
export { Approval, Signal, Timer, WaitForEvent } from "./components"
export { Voice, Sandbox, Supervisor } from "./components"
// ... all current components

// Driver (the bridge between React and @smithers/core)
export { ReactWorkflowDriver } from "./driver"

// Reconciler (for advanced use cases)
export { SmithersRenderer } from "./reconciler"

// Context
export { SmithersContext, buildContext } from "./context"

// Workflow type
export type { SmithersWorkflow, SmithersWorkflowOptions } from "./types"

// Convenience: runWorkflow wraps ReactWorkflowDriver.run
export { runWorkflow } from "./run"
```

---

## Dependency Graph

```
@smithers/core          (Effect, no React)
       ↑
@smithers/react         (React + @smithers/core)
       ↑
smithers                (CLI, server, agents, everything else)
```

`@smithers/react` depends on:
- `@smithers/core` — for WorkflowSession, extractGraph, types
- `react` — for component model
- `react-reconciler` — for custom host config
- `react-dom/server` — for renderPromptToText (MDX → markdown)

`@smithers/core` depends on:
- `effect` — core
- `@effect/workflow` — durable primitives
- `@effect/opentelemetry` — tracing export
- Zero React dependencies

---

## Migration Path

1. Extract `HostNode`/`HostElement`/`HostText` types and `extractFromHost`
   into `@smithers/core/graph`. These are already React-free.

2. Move scheduling logic (`scheduleTasks`, `buildPlanTree`) into
   `@smithers/core/scheduler`.

3. Create `WorkflowSession` interface in core with the call-in API.

4. Implement `ReactWorkflowDriver` in `@smithers/react` that replaces the
   current `runWorkflowBody` function in `engine/index.ts`.

5. Move components into `@smithers/react/components`.

6. The existing `engine/index.ts` (~6300 lines) gets split:
   - Scheduling, state machine, persistence, observability → `@smithers/core`
   - React rendering loop, agent execution wiring → `@smithers/react`
   - Public API (`runWorkflow`) → `@smithers/react/run`

7. `smithers` (the main package) becomes a consumer that re-exports from
   both packages and adds CLI, server, agents, gateway.
