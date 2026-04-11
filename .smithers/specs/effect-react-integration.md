# Effect ↔ React Integration — How They Plug Together

> Internal engineering document. Details the seam between `@smithers/core`
> (Effect) and `@smithers/react` (React adapter).

## Overview

This document covers the specific integration points where React and Effect
meet. The goal is to make the boundary explicit: React produces data, Effect
consumes it. Effect returns instructions, React acts on them.

---

## The Three Boundaries

There are exactly three places where React and Effect interact:

### Boundary 1: Graph Production

React renders JSX → reconciler builds HostNode tree → `extractGraph()` returns
`WorkflowGraph`. This is the only place React "writes" into the Effect world.

```
React world                          │  Effect world
                                     │
workflow.build(ctx)                  │
  → <Sequence>                       │
      <Task id="a" ... />            │
      <Parallel>                     │
        <Task id="b" ... />          │
        <Task id="c" ... />          │
      </Parallel>                    │
    </Sequence>                      │
  → React.createElement(...)         │
  → reconciler produces HostNode     │
                                     │
             HostNode ───────────────┼──→ extractGraph(root)
                                     │      → { xml, tasks, mountedTaskIds }
                                     │      → WorkflowGraph
                                     │
                                     │    session.submitGraph(graph)
                                     │      → EngineDecision
```

**What crosses the boundary:** `HostNode` (a plain object tree). No React
types, no React runtime, no fiber references. Just `{ tag, props, children }`.

**Who owns what:**
- React owns: component rendering, tree construction, diffing on re-render
- Effect owns: interpreting the tree (extractGraph), all downstream logic

### Boundary 2: Re-render Requests

The Effect engine determines that a re-render is needed (loop iteration
completed, mounted task set changed, hot reload). It returns a `ReRender`
decision. The driver calls back into React to produce a new graph.

```
Effect world                         │  React world
                                     │
session.submitGraph(graph)           │
  → schedule tasks                   │
  → tasks complete                   │
  → loop iteration done             │
  → EngineDecision:                  │
    { _tag: "ReRender",              │
      context: {                     │
        iteration: 3,               │
        outputs: { ... },           │
      }                              │
    }                                │
         EngineDecision ─────────────┼──→ driver receives decision
                                     │    driver calls workflow.build(newCtx)
                                     │    React re-renders
                                     │    reconciler diffs tree
                                     │    new HostNode produced
                                     │
                        ←────────────┼── driver calls session.submitGraph(newGraph)
```

**What crosses the boundary:** `RenderContext` (a plain data object with
iteration number, outputs, input, auth). No React types.

**Critical invariant:** The engine NEVER triggers a React render directly.
It returns an instruction. The driver translates that instruction into a
React render. If a different driver (programmatic) is used, it
translates the same instruction into whatever graph construction it uses.

### Boundary 3: Task Execution

The engine decides which tasks to execute. The driver executes them (using
agents, which may involve React for prompt rendering via MDX). The driver
reports results back.

```
Effect world                         │  React/Driver world
                                     │
EngineDecision:                      │
  { _tag: "Execute",                 │
    tasks: [                         │
      { nodeId: "a", agent, ... },   │
    ]                                │
  }                                  │
         EngineDecision ─────────────┼──→ driver receives tasks
                                     │    driver executes agent
                                     │    (may render MDX prompt via React)
                                     │    agent returns result
                                     │
                        ←────────────┼── session.taskCompleted({ nodeId: "a", output })
                                     │   or
                        ←────────────┼── session.taskFailed({ nodeId: "a", error })
```

**What crosses the boundary:** `TaskDescriptor` (engine → driver) and
`TaskOutput`/`TaskFailure` (driver → engine). Plain data objects.

---

## Data Types That Cross the Boundary

These types are defined in `@smithers/core` and used by `@smithers/react`:

```ts
// Shared types — defined in @smithers/core, consumed by @smithers/react

// Graph construction (React builds these, core extracts from them)
interface HostElement {
  kind: "element"
  tag: string                        // "smithers:task", "smithers:parallel", etc.
  props: Record<string, string>
  rawProps: Record<string, any>      // original props including functions, objects
  children: HostNode[]
}
interface HostText { kind: "text"; text: string }
type HostNode = HostElement | HostText

// Graph output (core produces these from HostNode)
interface WorkflowGraph {
  xml: XmlNode | null
  tasks: TaskDescriptor[]
  mountedTaskIds: string[]
}

// Engine decisions (core returns these, driver acts on them)
type EngineDecision = Execute | ReRender | Wait | ContinueAsNew | Finished | Failed

// Render context (core provides this when requesting a re-render)
interface RenderContext {
  runId: string
  iteration: number
  iterations: Record<string, number>
  input: unknown
  outputs: Record<string, unknown>
  auth?: RunAuthContext
}

// Task descriptors (core provides these when dispatching execution)
interface TaskDescriptor {
  nodeId: string
  iteration: number
  agent: AgentLike | AgentLike[]
  prompt: string | null
  outputTableName: string
  outputSchema: ZodObject<any> | null
  retries: number
  retryPolicy?: RetryPolicy
  heartbeatTimeoutMs: number | null
  timeoutMs: number | null
  continueOnFail: boolean
  // ... etc
}
```

---

## What React Does NOT Do

In this architecture, React's role is strictly limited:

| Concern | Who owns it |
|---------|-------------|
| Workflow structure definition | React (via JSX components) |
| Tree diffing on re-render | React (via reconciler) |
| MDX prompt rendering | React (via react-dom/server) |
| Graph extraction (HostNode → TaskDescriptor) | **Core** |
| Scheduling (what runs when) | **Core** |
| Task state machine | **Core** |
| Concurrency limits | **Core** |
| Retry policy | **Core** |
| Cache | **Core** |
| Persistence (DB reads/writes) | **Core** |
| Observability (metrics, tracing) | **Core** |
| Approvals, timers, signals | **Core** |
| Continue-as-new | **Core** |
| Loop iteration advancement | **Core** |
| Error handling / fatal detection | **Core** |
| Heartbeat watchdog | **Core** |

React is a **graph construction tool**. Everything else is Effect.

---

## The Single `runPromise` Boundary

The driver has exactly one place where it escapes Effect:

```ts
class ReactWorkflowDriver {
  private runEffect<A>(effect: Effect.Effect<A, any, any>): Promise<A> {
    return this.runtime.runPromise(effect)
  }
}
```

Every interaction with the core library goes through this single method.
The driver calls `this.runEffect(session.submitGraph(...))`,
`this.runEffect(session.taskCompleted(...))`, etc.

Today's engine has 28 escape points in `engine/index.ts` alone. This
architecture reduces that to 1 per driver method call, and the driver
is a ~200 line class instead of a ~6300 line file.

---

## Alternative Drivers (Proof of Generality)

The architecture is correct if the same `@smithers/core` can be driven
without React. Here are two examples:

### Programmatic Driver (tests, scripts)

```ts
import { createSession, extractGraph } from "@smithers/core"

// Build a WorkflowGraph without React — just construct HostNodes directly
const graph = extractGraph({
  kind: "element",
  tag: "smithers:workflow",
  props: {},
  rawProps: {},
  children: [
    {
      kind: "element",
      tag: "smithers:task",
      props: { id: "fetch" },
      rawProps: { id: "fetch", agent: myAgent, output: MySchema },
      children: [],
    },
  ],
})

const session = await runtime.runPromise(createSession({ db, runId }))
let decision = await runtime.runPromise(session.submitGraph(graph))
// ... drive loop manually
```

### Headless Driver (CI, batch processing)

```ts
import { createSession } from "@smithers/core"

// Pre-computed graph from a build step — no rendering at all
const graph = JSON.parse(fs.readFileSync("workflow.graph.json", "utf8"))
const session = await runtime.runPromise(createSession({ db, runId }))
let decision = await runtime.runPromise(session.submitGraph(graph))
// ... drive loop
```

Neither driver imports React or `@smithers/react`. They talk directly to
`@smithers/core` using the same `WorkflowSession` API.

---

## Event Flow Diagram

Complete lifecycle of a workflow run with the React driver:

```
1. INIT
   smithers-react: ReactWorkflowDriver.run(opts)
   smithers-react: session = runEffect(createSession({ db, runId, ... }))

2. FIRST RENDER
   smithers-react: ctx = buildContext({ runId, iteration: 0, ... })
   smithers-react: element = workflow.build(ctx)          ← React
   smithers-react: graph = renderer.render(element)       ← React reconciler + core extractGraph
   smithers-react: decision = runEffect(session.submitGraph(graph))

3. EXECUTE
   smithers-core:  returns { _tag: "Execute", tasks: [a, b] }
   smithers-react: execute agents for tasks a and b concurrently
   smithers-react: runEffect(session.taskCompleted({ nodeId: "a", ... }))
   smithers-react: runEffect(session.taskCompleted({ nodeId: "b", ... }))

4. RE-RENDER (loop iteration)
   smithers-core:  returns { _tag: "ReRender", context: { iteration: 1, ... } }
   smithers-react: ctx = buildContext(decision.context)
   smithers-react: element = workflow.build(ctx)          ← React re-renders
   smithers-react: graph = renderer.render(element)       ← React diffs, core extracts
   smithers-react: decision = runEffect(session.submitGraph(graph))

5. WAIT (approval gate)
   smithers-core:  returns { _tag: "Wait", reason: { _tag: "Approval", nodeId: "review" } }
   smithers-react: waits for external approval event
   smithers-react: runEffect(session.approvalResolved("review", { approved: true, ... }))

6. FINISH
   smithers-core:  returns { _tag: "Finished", result: { runId, status: "finished", output } }
   smithers-react: return result
```
