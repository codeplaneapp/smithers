# @smithers/core — Effect Library Architecture Spec

> Internal engineering document. Defines the architecture of the extracted Effect
> core library that smithers and smithers-react consume.

## Overview

`@smithers/core` is a standalone Effect library with zero React dependency. It
owns workflow scheduling, task state management, persistence, observability, and
durable primitives (approvals, timers, signals, continue-as-new). It exposes a
**call-in API** — the library never reaches out to a driver. A driver (React,
CLI, test harness) calls methods on the library and receives instructions back.

---

## Design Principles

1. **No driver dependency.** The library does not import React, does not know
   how graphs are constructed, and never calls back into driver code.

2. **Effect-native internals.** All internal logic is composed as Effect
   programs. Services use `Context.Tag` and compose via `Layer`. No internal
   `runPromise` escapes — those happen at the driver boundary.

3. **Call-in, instructions-out.** The driver submits events (graph rendered, task
   completed, approval resolved). The library returns an `EngineDecision` that
   tells the driver what to do next. The library is purely reactive.

4. **Single runtime.** One `ManagedRuntime` with a unified layer. Today's 4
   separate runtimes collapse into one composed layer.

---

## Package Structure

```
@smithers/core/
  src/
    session/          # WorkflowSession — the primary API surface
    scheduler/        # Task scheduling, plan tree, concurrency limits
    graph/            # WorkflowGraph types, graph extraction from HostNode
    state/            # Task state machine (pending → in-progress → done/failed)
    persistence/      # Frame commits, snapshots, attempt tracking
    observability/    # MetricsService, TracingService, correlation context
    durables/         # Approvals, wait-for-event, timers, continue-as-new
    execution/        # Task execution, retry policy, cache, heartbeat watchdog
    interop/          # Effect ↔ Promise bridge utilities (fromPromise, fromSync)
    runtime/          # Unified ManagedRuntime factory
    errors/           # SmithersError, error codes
```

---

## Core API: WorkflowSession

The primary surface is a stateful session object. The driver creates one per
workflow run and interacts with it through typed methods. Each method returns an
`EngineDecision` — an instruction for the driver.

```ts
import { Context, Effect, Layer } from "effect"

// ── What the driver gives the engine ──

interface WorkflowGraph {
  xml: XmlNode | null
  tasks: ReadonlyArray<TaskDescriptor>
  mountedTaskIds: ReadonlyArray<string>
}

interface TaskOutput {
  nodeId: string
  iteration: number
  output: unknown
  text?: string | null
  usage?: TokenUsage | null
}

interface TaskFailure {
  nodeId: string
  iteration: number
  error: unknown
}

// ── What the engine tells the driver ──

type EngineDecision =
  | { readonly _tag: "Execute"; readonly tasks: ReadonlyArray<TaskDescriptor> }
  | { readonly _tag: "ReRender"; readonly context: RenderContext }
  | { readonly _tag: "Wait"; readonly reason: WaitReason }
  | { readonly _tag: "ContinueAsNew"; readonly transition: ContinueAsNewTransition }
  | { readonly _tag: "Finished"; readonly result: RunResult }
  | { readonly _tag: "Failed"; readonly error: SmithersError }

type WaitReason =
  | { readonly _tag: "Approval"; readonly nodeId: string }
  | { readonly _tag: "Event"; readonly eventName: string }
  | { readonly _tag: "Timer"; readonly resumeAtMs: number }
  | { readonly _tag: "RetryBackoff"; readonly waitMs: number }
  | { readonly _tag: "ExternalTrigger" }

// ── The session interface ──

class WorkflowSession extends Context.Tag("WorkflowSession")<
  WorkflowSession,
  {
    // Driver submits a rendered graph (from React, programmatic, etc.)
    readonly submitGraph: (graph: WorkflowGraph) => Effect.Effect<EngineDecision>

    // Driver reports task outcomes
    readonly taskCompleted: (output: TaskOutput) => Effect.Effect<EngineDecision>
    readonly taskFailed: (failure: TaskFailure) => Effect.Effect<EngineDecision>

    // External events resolved by the driver
    readonly approvalResolved: (
      nodeId: string,
      resolution: ApprovalResolution,
    ) => Effect.Effect<EngineDecision>
    readonly eventReceived: (
      eventName: string,
      payload: unknown,
    ) => Effect.Effect<EngineDecision>
    readonly cancelRequested: () => Effect.Effect<EngineDecision>

    // Read-only queries (for UIs, CLIs, devtools)
    readonly getTaskStates: () => Effect.Effect<TaskStateMap>
    readonly getSchedule: () => Effect.Effect<ScheduleSnapshot>
    readonly getCurrentGraph: () => Effect.Effect<WorkflowGraph | null>
  }
>{}
```

---

## Observability Service

Replaces the 14+ scattered `void runPromise(Metric.*)` escapes in the current
engine. Metrics and tracing compose as Effect services — they never escape
internally.

```ts
class MetricsService extends Context.Tag("MetricsService")<
  MetricsService,
  {
    readonly increment: (name: MetricName, labels?: MetricLabels) => Effect.Effect<void>
    readonly gauge: (name: MetricName, value: number) => Effect.Effect<void>
    readonly histogram: (name: MetricName, value: number) => Effect.Effect<void>
    readonly renderPrometheus: () => Effect.Effect<string>
  }
>{}

class TracingService extends Context.Tag("TracingService")<
  TracingService,
  {
    readonly withSpan: <A, E, R>(
      name: string,
      effect: Effect.Effect<A, E, R>,
      attributes?: Record<string, unknown>,
    ) => Effect.Effect<A, E, R>
    readonly annotate: (attributes: Record<string, unknown>) => Effect.Effect<void>
    readonly withCorrelation: <A, E, R>(
      context: CorrelationPatch,
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E, R>
  }
>{}
```

Inside the engine, what is today:

```ts
void runPromise(Metric.increment(cacheHits))
```

Becomes:

```ts
yield* metrics.increment("cache.hits")
```

No escape. The `runPromise` happens once at the driver boundary.

---

## Unified Runtime

Today there are 4 separate `ManagedRuntime` instances. The core library provides
a single composable layer:

```ts
// The full runtime layer — drivers compose what they need
const SmithersCoreLayer = Layer.mergeAll(
  MetricsServiceLive,
  TracingServiceLive,
  CorrelationContextLive,
  SchedulerLive,
  PersistenceLive,           // requires StorageService from driver
  DurablePrimitivesLive,
  HeartbeatWatchdogLive,
  CacheLive,
)

// Driver provides storage + creates the runtime
const runtime = ManagedRuntime.make(
  SmithersCoreLayer.pipe(
    Layer.provide(SqliteStorageLive(db)),   // driver provides this
  )
)
```

The `WorkflowEngine` and `DurableDeferred` layers from `@effect/workflow` compose
into this single layer instead of living in isolated runtimes.

---

## Graph Extraction

`extractFromHost()` today lives in `src/dom/extract.ts`. It operates on
`HostNode` — a plain `{ tag, props, children }` tree — not React types. This
function moves into `@smithers/core` as the canonical graph extraction logic.

```ts
// @smithers/core/graph

interface HostNode {
  readonly kind: "element" | "text"
}

interface HostElement extends HostNode {
  readonly kind: "element"
  readonly tag: string
  readonly props: Record<string, string>
  readonly rawProps: Record<string, any>
  readonly children: ReadonlyArray<HostNode>
}

interface HostText extends HostNode {
  readonly kind: "text"
  readonly text: string
}

// Pure function: tree in, graph out
const extractGraph: (
  root: HostNode | null,
  opts?: ExtractOptions,
) => WorkflowGraph
```

React or any other driver constructs a `HostNode` tree however it likes,
then calls `extractGraph`. The core library handles loop scoping, parallel group
resolution, worktree stacking, saga/try-catch-finally, and dedup.

---

## Scheduler

The scheduling algorithm (`scheduleTasks`, `buildPlanTree`) is already pure
computation with no I/O. It moves into the core library unchanged, wrapped as
an Effect service so it has access to metrics/tracing:

```ts
class Scheduler extends Context.Tag("Scheduler")<
  Scheduler,
  {
    readonly schedule: (
      plan: PlanNode,
      states: TaskStateMap,
      descriptors: Map<string, TaskDescriptor>,
      ralphState: RalphStateMap,
      retryWait: RetryWaitMap,
      nowMs: number,
    ) => Effect.Effect<ScheduleResult>
  }
>{}
```

---

## Persistence Interface

The core library defines a storage interface. Drivers provide the implementation
(SQLite, Postgres, in-memory for tests):

```ts
class StorageService extends Context.Tag("StorageService")<
  StorageService,
  {
    readonly getRun: (runId: string) => Effect.Effect<Run | null>
    readonly updateRun: (runId: string, patch: RunPatch) => Effect.Effect<void>
    readonly insertFrame: (frame: FrameRow) => Effect.Effect<void>
    readonly insertNode: (node: NodeRow) => Effect.Effect<void>
    readonly insertAttempt: (attempt: AttemptRow) => Effect.Effect<void>
    readonly updateAttempt: (/* ... */) => Effect.Effect<void>
    readonly listAttempts: (runId: string, nodeId: string, iteration: number) => Effect.Effect<ReadonlyArray<Attempt>>
    readonly withTransaction: <A, E, R>(
      label: string,
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E, R>
    // ... etc
  }
>{}
```

---

## Error Model

All errors are typed and tagged:

```ts
class EngineError extends Data.TaggedError("EngineError")<{
  readonly code: EngineErrorCode
  readonly message: string
  readonly context?: Record<string, unknown>
}>{}

type EngineErrorCode =
  | "TASK_HEARTBEAT_TIMEOUT"
  | "DUPLICATE_ID"
  | "NESTED_LOOP"
  | "INVALID_CONTINUATION_STATE"
  | "TASK_ID_REQUIRED"
  // ...
```

---

## What Stays Out

The core library does NOT include:

- React components, reconciler, JSX anything
- Agent implementations (Claude, Gemini, etc.)
- Vercel AI SDK adapters
- CLI rendering, terminal UI
- HTTP server, WebSocket gateway
- MDX rendering
- The `SmithersWorkflow.build` function type (that's React-specific)
