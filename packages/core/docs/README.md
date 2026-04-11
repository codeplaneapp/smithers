# @smithers/core

`@smithers/core` is the React-free Effect core for Smithers workflow
execution. It owns workflow orchestration. Drivers own rendering, process I/O,
agent execution, and user interfaces.

The package is designed around a strict boundary:

```text
driver calls in        @smithers/core computes        driver acts
--------------         --------------------        -----------
submitGraph(graph) ->  EngineDecision.Execute  ->  run tasks
taskCompleted(out) ->  EngineDecision.ReRender ->  render again
eventReceived(...) ->  EngineDecision.Wait     ->  wait externally
cancelRequested()  ->  EngineDecision.Failed   ->  stop
```

The engine never calls a driver. It returns instructions. A React driver, CLI
driver, test harness, or batch runner can use the same session API.

## Implementation Status

This document describes the package contract from the architecture specs and
the checked-in source. The current package contains concrete source for:

- `errors`
- `graph` types and extraction
- `scheduler` pure scheduling and `SchedulerLive`
- `durables` primitive service types
- `execution` default compute/static executor
- `observability` metrics, tracing, correlation, and Prometheus helpers
- `persistence` storage interface and in-memory storage
- `session` in-memory `WorkflowSession`
- `runtime` composed `SmithersCoreLayer` and run helpers
- `state` helpers
- `interop` helpers

The root `src/index.ts` re-exports all implemented submodules. The architecture
spec uses the name `createSession`; the current source exports
`makeWorkflowSession` and `WorkflowSessionLive` instead.

## Overview

Smithers workflows are trees of host nodes. A driver constructs a host tree and
passes it to `extractGraph`. The graph contains a normalized XML-like tree and a
flat list of `TaskDescriptor` records. The engine schedules those task
descriptors, tracks task state, persists frames, records metrics, and returns
`EngineDecision` values.

`@smithers/core` exists to remove workflow execution from React. React is
one way to build a `HostNode` tree. It is not part of scheduling, retries,
persistence, approvals, timers, signals, or metrics.

Use this package when you need to:

- Run a Smithers workflow outside React.
- Write a custom driver.
- Test workflow execution with direct `HostNode` values.
- Keep all internal workflow logic inside Effect.
- Provide your own storage and runtime services.

## Core Concepts

### WorkflowSession

`WorkflowSession` is the Effect service tag for the call-in API. Create one
session service per workflow run. The driver submits facts about the outside
world and receives one engine decision.

```ts
import { Effect } from "effect";
import type {
  ApprovalResolution,
  EngineDecision,
  ScheduleSnapshot,
  TaskFailure,
  TaskOutput,
  TaskStateMap,
  WorkflowGraph,
} from "@smithers/core";

export type WorkflowSessionService = {
  readonly submitGraph: (
    graph: WorkflowGraph,
  ) => Effect.Effect<EngineDecision>;

  readonly taskCompleted: (
    output: TaskOutput,
  ) => Effect.Effect<EngineDecision>;

  readonly taskFailed: (
    failure: TaskFailure,
  ) => Effect.Effect<EngineDecision>;

  readonly approvalResolved: (
    nodeId: string,
    resolution: ApprovalResolution,
  ) => Effect.Effect<EngineDecision>;

  readonly eventReceived: (
    eventName: string,
    payload: unknown,
  ) => Effect.Effect<EngineDecision>;

  readonly cancelRequested: () => Effect.Effect<EngineDecision>;

  readonly getTaskStates: () => Effect.Effect<TaskStateMap>;
  readonly getSchedule: () => Effect.Effect<ScheduleSnapshot | null>;
  readonly getCurrentGraph: () => Effect.Effect<WorkflowGraph | null>;
};
```

The session stores run state. The driver does not schedule tasks itself. It only
executes instructions and reports results.

### WorkflowGraph

`WorkflowGraph` is a rendered workflow graph. It is produced from a `HostNode`
tree.

```ts
export type WorkflowGraph = {
  readonly xml: XmlNode | null;
  readonly tasks: readonly TaskDescriptor[];
  readonly mountedTaskIds: readonly string[];
};
```

`xml` is the normalized workflow tree. `tasks` is the flat work list extracted
from that tree. `mountedTaskIds` is the set of task IDs present in the latest
render.

React drivers produce `HostNode` trees with a reconciler. Non-React drivers can
build the same data manually.

```ts
import { extractGraph, type HostNode } from "@smithers/core";

const root: HostNode = {
  kind: "element",
  tag: "smithers:workflow",
  props: {},
  rawProps: {},
  children: [
    {
      kind: "element",
      tag: "smithers:task",
      props: { id: "hello" },
      rawProps: {
        id: "hello",
        output: "greetings",
        __smithersKind: "compute",
        __smithersComputeFn: () => ({ message: "hello" }),
      },
      children: [{ kind: "text", text: "Say hello" }],
    },
  ],
};

const graph = extractGraph(root);
```

### EngineDecision

`EngineDecision` is the instruction the engine returns after each call.

```ts
export type EngineDecision =
  | { readonly _tag: "Execute"; readonly tasks: readonly TaskDescriptor[] }
  | { readonly _tag: "ReRender"; readonly context: RenderContext }
  | { readonly _tag: "Wait"; readonly reason: WaitReason }
  | {
      readonly _tag: "ContinueAsNew";
      readonly transition: ContinueAsNewTransition;
    }
  | { readonly _tag: "Finished"; readonly result: RunResult }
  | { readonly _tag: "Failed"; readonly error: SmithersError };

export type WaitReason =
  | { readonly _tag: "Approval"; readonly nodeId: string }
  | { readonly _tag: "Event"; readonly eventName: string }
  | { readonly _tag: "Timer"; readonly resumeAtMs: number }
  | { readonly _tag: "RetryBackoff"; readonly waitMs: number }
  | { readonly _tag: "ExternalTrigger" };
```

Drivers must exhaustively handle decisions.

```ts
async function handleDecision(decision: EngineDecision): Promise<void> {
  switch (decision._tag) {
    case "Execute":
      await runTasks(decision.tasks);
      return;
    case "ReRender":
      await renderAgain(decision.context);
      return;
    case "Wait":
      await waitOutsideCore(decision.reason);
      return;
    case "ContinueAsNew":
      await startNextRun(decision.transition);
      return;
    case "Finished":
      return;
    case "Failed":
      throw decision.error;
  }
}
```

### Call In, Instructions Out

The driver owns all side effects that cross the driver boundary:

- Rendering a workflow tree.
- Calling agents.
- Waiting for approvals or events.
- Sleeping until a timer.
- Launching a new run after `ContinueAsNew`.
- Calling `runtime.runPromise`.

The engine owns pure workflow execution state:

- Extracting task descriptors from host trees.
- Scheduling runnable tasks.
- Tracking task states.
- Handling retry policy.
- Recording durable frames.
- Returning the next instruction.

There is one Effect escape hatch: the driver boundary.

```ts
class Driver {
  constructor(private readonly runtime: Runtime) {}

  private runEffect<A, E>(effect: Effect.Effect<A, E, never>): Promise<A> {
    return this.runtime.runPromise(effect);
  }
}
```

Do not call `runPromise` inside core services. Compose Effects and let the
driver run the returned program.

## API Reference

### Public Import Paths

The package metadata declares these public import paths:

```ts
import {} from "@smithers/core";
import {} from "@smithers/core/session";
import {} from "@smithers/core/scheduler";
import {} from "@smithers/core/graph";
import {} from "@smithers/core/state";
import {} from "@smithers/core/persistence";
import {} from "@smithers/core/observability";
import {} from "@smithers/core/durables";
import {} from "@smithers/core/execution";
import {} from "@smithers/core/interop";
import {} from "@smithers/core/runtime";
import {} from "@smithers/core/errors";
```

The root `src/index.ts` re-exports these submodules.

### WorkflowSession and makeWorkflowSession

`makeWorkflowSession` creates a `WorkflowSessionService` for one run.

```ts
import { makeWorkflowSession } from "@smithers/core";

const session = makeWorkflowSession({
  runId: "run_123",
});
```

Options:

```ts
export type WorkflowSessionOptions = {
  readonly runId?: string;
  readonly nowMs?: () => number;
};
```

Exports:

```ts
export class WorkflowSession extends Context.Tag("WorkflowSession")<
  WorkflowSession,
  WorkflowSessionService
>() {}

export function makeWorkflowSession(
  options?: WorkflowSessionOptions,
): WorkflowSessionService;

export const WorkflowSessionLive: Layer.Layer<WorkflowSession>;
```

The architecture spec uses the name `createSession`. This source currently
exports `makeWorkflowSession`; add a `createSession` alias only if the public
contract requires that exact name.

Common usage:

```ts
const graph = extractGraph(root);

let decision = await runtime.runPromise(session.submitGraph(graph));

if (decision._tag === "Execute") {
  const task = decision.tasks[0];
  const output = await callAgent(task);

  decision = await runtime.runPromise(
    session.taskCompleted({
      nodeId: task.nodeId,
      iteration: task.iteration,
      output,
    }),
  );
}
```

Session boundary types:

```ts
export type TokenUsage = {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly reasoningTokens?: number;
  readonly totalTokens?: number;
  readonly [key: string]: unknown;
};

export type TaskOutput = {
  readonly nodeId: string;
  readonly iteration: number;
  readonly output: unknown;
  readonly text?: string | null;
  readonly usage?: TokenUsage | null;
};

export type TaskFailure = {
  readonly nodeId: string;
  readonly iteration: number;
  readonly error: unknown;
};

export type RenderContext = {
  readonly runId: string;
  readonly graph: WorkflowGraph | null;
  readonly taskStates: TaskStateMap;
  readonly outputs: ReadonlyMap<string, TaskOutput>;
  readonly ralphIterations: ReadonlyMap<string, number>;
};

export type RunResult = {
  readonly runId: string;
  readonly status:
    | "finished"
    | "failed"
    | "cancelled"
    | "continued"
    | "waiting-approval"
    | "waiting-event"
    | "waiting-timer";
  readonly output?: unknown;
  readonly error?: unknown;
  readonly nextRunId?: string;
};
```

### extractGraph

`extractGraph` turns a driver-owned `HostNode` tree into a `WorkflowGraph`.

```ts
import { extractGraph } from "@smithers/core/graph";

const graph = extractGraph(root, {
  defaultIteration: 0,
  workflowPath: "/repo/workflows/main.tsx",
});
```

Signature:

```ts
export declare function extractGraph(
  root: HostNode | null,
  opts?: ExtractOptions,
): WorkflowGraph;
```

`ExtractOptions` is implemented in `src/graph/types.ts`:

```ts
export type ExtractOptions = {
  readonly ralphIterations?: ReadonlyMap<string, number> | Record<string, number>;
  readonly defaultIteration?: number;
  readonly baseRootDir?: string;
  readonly workflowPath?: string | null;
};
```

Use `ralphIterations` to tell extraction which loop iteration is active for a
loop ID. Use `defaultIteration` for tasks outside a loop. Use `baseRootDir` and
`workflowPath` when extraction must resolve worktree paths relative to the
workflow file.

`extractFromHost` is an alias for `extractGraph`.

```ts
import { extractFromHost } from "@smithers/core/graph";

const graph = extractFromHost(root);
```

Implemented extraction recognizes these host tags:

- `smithers:workflow`
- `smithers:sequence`
- `smithers:parallel`
- `smithers:merge-queue`
- `smithers:ralph`
- `smithers:worktree`
- `smithers:voice`
- `smithers:task`
- `smithers:subflow`
- `smithers:sandbox`
- `smithers:wait-for-event`
- `smithers:timer`
- `smithers:saga`
- `smithers:try-catch-finally`

Extraction validates duplicate IDs, missing task outputs, nested loops,
worktree paths, and timer inputs. It resolves worktree paths, carries parallel
group limits, attaches voice context, scopes task IDs inside loops, and returns
mounted task IDs in `nodeId::iteration` form.

### Graph Types

These graph types are implemented in `src/graph/types.ts`.

```ts
export type XmlNode = XmlElement | XmlText;

export type XmlElement = {
  readonly kind: "element";
  readonly tag: string;
  readonly props: Record<string, string>;
  readonly children: readonly XmlNode[];
};

export type XmlText = {
  readonly kind: "text";
  readonly text: string;
};

export type HostNode = HostElement | HostText;

export type HostElement = {
  readonly kind: "element";
  readonly tag: string;
  readonly props: Record<string, string>;
  readonly rawProps: Record<string, unknown>;
  readonly children: readonly HostNode[];
};

export type HostText = {
  readonly kind: "text";
  readonly text: string;
};
```

`props` contains string props suitable for the XML tree. `rawProps` carries
driver-only values such as functions, schemas, agent objects, and provider
instances.

### TaskDescriptor

`TaskDescriptor` is the engine-facing description of one piece of work.

```ts
export type TaskDescriptor = {
  readonly nodeId: string;
  readonly ordinal: number;
  readonly iteration: number;
  readonly ralphId?: string;
  readonly dependsOn?: readonly string[];
  readonly needs?: Record<string, string>;

  readonly worktreeId?: string;
  readonly worktreePath?: string;
  readonly worktreeBranch?: string;
  readonly worktreeBaseBranch?: string;

  readonly outputTable: unknown | null;
  readonly outputTableName: string;
  readonly outputRef?: unknown;
  readonly outputSchema?: unknown;

  readonly parallelGroupId?: string;
  readonly parallelMaxConcurrency?: number;

  readonly needsApproval: boolean;
  readonly waitAsync?: boolean;
  readonly approvalMode?: "gate" | "decision" | "select" | "rank";
  readonly approvalOnDeny?: "fail" | "continue" | "skip";
  readonly approvalOptions?: readonly ApprovalOption[];
  readonly approvalAllowedScopes?: readonly string[];
  readonly approvalAllowedUsers?: readonly string[];
  readonly approvalAutoApprove?: {
    readonly after?: number;
    readonly audit?: boolean;
    readonly conditionMet?: boolean;
    readonly revertOnMet?: boolean;
  };

  readonly skipIf: boolean;
  readonly retries: number;
  readonly retryPolicy?: RetryPolicy;
  readonly timeoutMs: number | null;
  readonly heartbeatTimeoutMs: number | null;
  readonly continueOnFail: boolean;
  readonly cachePolicy?: CachePolicy;

  readonly agent?: AgentLike | readonly AgentLike[];
  readonly prompt?: string;
  readonly staticPayload?: unknown;
  readonly computeFn?: () => unknown | Promise<unknown>;

  readonly label?: string;
  readonly meta?: Record<string, unknown>;
  readonly scorers?: ScorersMap;
  readonly voice?: VoiceProvider;
  readonly voiceSpeaker?: string;
  readonly memoryConfig?: TaskMemoryConfig;
};
```

A driver usually cares about these fields:

- `nodeId` and `iteration`: identity for completion and failure reports.
- `agent`, `prompt`, `staticPayload`, `computeFn`: execution input.
- `timeoutMs`, `heartbeatTimeoutMs`, `retries`, `retryPolicy`: execution policy.
- `outputSchema`, `outputTableName`, `outputRef`: output validation and storage.
- `needsApproval`, approval fields: human gates.
- `parallelGroupId`, `parallelMaxConcurrency`: concurrency limits.

Retry and cache policy types:

```ts
export type RetryPolicy = {
  readonly backoff?: "fixed" | "linear" | "exponential";
  readonly initialDelayMs?: number;
  readonly maxDelayMs?: number;
  readonly multiplier?: number;
  readonly jitter?: boolean;
};

export type CachePolicy = {
  readonly key?: string;
  readonly ttlMs?: number;
  readonly scope?: "run" | "workflow" | "global";
  readonly [key: string]: unknown;
};
```

Approval option type:

```ts
export type ApprovalOption = {
  readonly key: string;
  readonly label: string;
  readonly summary?: string;
  readonly metadata?: Record<string, unknown>;
};
```

Placeholder type exports used by descriptors:

```ts
export type VoiceProvider = unknown;
export type AgentLike = unknown;
export type ScorersMap = Record<string, unknown>;
export type TaskMemoryConfig = Record<string, unknown>;
```

### WorkflowGraph and GraphSnapshot

```ts
export type WorkflowGraph = {
  readonly xml: XmlNode | null;
  readonly tasks: readonly TaskDescriptor[];
  readonly mountedTaskIds: readonly string[];
};

export type GraphSnapshot = {
  readonly runId: string;
  readonly frameNo: number;
  readonly xml: XmlNode | null;
  readonly tasks: readonly TaskDescriptor[];
};
```

`WorkflowGraph` is live input to the engine. `GraphSnapshot` is the persisted
frame shape.

### Task State Exports

`src/state/index.ts` implements the task state model.

```ts
export type TaskState =
  | "pending"
  | "waiting-approval"
  | "waiting-event"
  | "waiting-timer"
  | "in-progress"
  | "finished"
  | "failed"
  | "cancelled"
  | "skipped";

export type TaskStateMap = Map<string, TaskState>;
export type ReadonlyTaskStateMap = ReadonlyMap<string, TaskState>;

export type TaskRecord = {
  readonly descriptor: TaskDescriptor;
  readonly state: TaskState;
  readonly output?: unknown;
  readonly error?: unknown;
  readonly updatedAtMs: number;
};
```

Helpers:

```ts
import {
  buildStateKey,
  cloneTaskStateMap,
  isTerminalState,
  parseStateKey,
} from "@smithers/core/state";

const key = buildStateKey("fetch", 2); // "fetch::2"
const parsed = parseStateKey(key); // { nodeId: "fetch", iteration: 2 }

isTerminalState("finished"); // true
isTerminalState("failed"); // false
isTerminalState("failed", { continueOnFail: true }); // true

const copy = cloneTaskStateMap(existingStates);
```

### Scheduler

`src/scheduler/index.ts` implements plan construction and task scheduling.

Public exports:

- `PlanNode`
- `ScheduleResult`
- `RalphMeta`
- `ContinuationRequest`
- `RalphState`
- `RalphStateMap`
- `RetryWaitMap`
- `ScheduleSnapshot`
- `Scheduler`
- `buildPlanTree`
- `scheduleTasks`
- `buildStateKey`
- `SchedulerLive`

Plan nodes:

```ts
export type PlanNode =
  | { readonly kind: "task"; readonly nodeId: string }
  | { readonly kind: "sequence"; readonly children: readonly PlanNode[] }
  | { readonly kind: "parallel"; readonly children: readonly PlanNode[] }
  | {
      readonly kind: "ralph";
      readonly id: string;
      readonly children: readonly PlanNode[];
      readonly until: boolean;
      readonly maxIterations: number;
      readonly onMaxReached: "fail" | "return-last";
      readonly continueAsNewEvery?: number;
    }
  | { readonly kind: "continue-as-new"; readonly stateJson?: string }
  | { readonly kind: "group"; readonly children: readonly PlanNode[] }
  | {
      readonly kind: "saga";
      readonly id: string;
      readonly actionChildren: readonly PlanNode[];
      readonly compensationChildren: readonly PlanNode[];
      readonly onFailure: "compensate" | "compensate-and-fail" | "fail";
    }
  | {
      readonly kind: "try-catch-finally";
      readonly id: string;
      readonly tryChildren: readonly PlanNode[];
      readonly catchChildren: readonly PlanNode[];
      readonly finallyChildren: readonly PlanNode[];
    };
```

Schedule result:

```ts
export type ScheduleResult = {
  readonly runnable: readonly TaskDescriptor[];
  readonly pendingExists: boolean;
  readonly waitingApprovalExists: boolean;
  readonly waitingEventExists: boolean;
  readonly waitingTimerExists: boolean;
  readonly readyRalphs: readonly RalphMeta[];
  readonly continuation?: ContinuationRequest;
  readonly nextRetryAtMs?: number;
  readonly fatalError?: string;
};
```

Loop and retry state:

```ts
export type RalphMeta = {
  readonly id: string;
  readonly until: boolean;
  readonly maxIterations: number;
  readonly onMaxReached: "fail" | "return-last";
  readonly continueAsNewEvery?: number;
};

export type ContinuationRequest = {
  readonly stateJson?: string;
};

export type RalphState = {
  readonly iteration: number;
  readonly done: boolean;
};

export type RalphStateMap = Map<string, RalphState>;
export type RetryWaitMap = Map<string, number>;

export type ScheduleSnapshot = {
  readonly plan: PlanNode | null;
  readonly result: ScheduleResult;
  readonly computedAtMs: number;
};
```

Build a plan from extracted XML:

```ts
import { buildPlanTree } from "@smithers/core/scheduler";

const { plan, ralphs } = buildPlanTree(graph.xml, ralphState);
```

Schedule runnable tasks:

```ts
import {
  buildPlanTree,
  scheduleTasks,
} from "@smithers/core/scheduler";
import { buildStateKey } from "@smithers/core/state";

const states = new Map([
  [buildStateKey("collect", 0), "finished"],
  [buildStateKey("summarize", 0), "pending"],
] as const);

const descriptors = new Map(
  graph.tasks.map((task) => [task.nodeId, task]),
);

const { plan } = buildPlanTree(graph.xml);

const result = scheduleTasks(
  plan,
  states,
  descriptors,
  new Map(),
  new Map(),
  Date.now(),
);

for (const task of result.runnable) {
  await executeTask(task);
}
```

The scheduler enforces:

- sequence ordering
- parallel traversal
- `parallelMaxConcurrency`
- explicit `dependsOn`
- retry backoff via `RetryWaitMap`
- async wait traversal for approvals and events
- `Ralph` loop readiness
- `continue-as-new` requests
- saga compensation ordering
- try/catch/finally ordering

`Scheduler` is the Effect service tag. `SchedulerLive` wraps the pure
`scheduleTasks` function with tracing and a queue-depth metric.

```ts
import { Scheduler } from "@smithers/core/scheduler";

const scheduled = Effect.gen(function* () {
  const scheduler = yield* Scheduler;
  return yield* scheduler.schedule(
    plan,
    states,
    descriptors,
    ralphState,
    retryWait,
    Date.now(),
  );
});
```

### DurablePrimitives

`src/durables/index.ts` defines the durable primitive service used by sessions
for approvals, external events, timers, and continue-as-new.

```ts
export type ApprovalResolution = {
  readonly approved: boolean;
  readonly note?: string;
  readonly decidedBy?: string;
  readonly optionKey?: string;
  readonly payload?: unknown;
};

export type TimerRequest = {
  readonly nodeId: string;
  readonly resumeAtMs: number;
};

export type ContinueAsNewTransition = {
  readonly reason: "explicit" | "loop-threshold" | "driver";
  readonly iteration?: number;
  readonly statePayload?: unknown;
  readonly stateJson?: string;
  readonly newRunId?: string;
  readonly carriedStateBytes?: number;
  readonly ancestryDepth?: number;
};
```

Service shape:

```ts
export type DurablePrimitivesService = {
  readonly resolveApproval: (
    nodeId: string,
    resolution: ApprovalResolution,
  ) => Effect.Effect<ApprovalResolution>;

  readonly receiveEvent: (
    eventName: string,
    payload: unknown,
  ) => Effect.Effect<{ readonly eventName: string; readonly payload: unknown }>;

  readonly createTimer: (
    request: TimerRequest,
  ) => Effect.Effect<TimerRequest>;

  readonly continueAsNew: (
    transition: ContinueAsNewTransition,
  ) => Effect.Effect<ContinueAsNewTransition>;
};

export class DurablePrimitives extends Context.Tag("DurablePrimitives")<
  DurablePrimitives,
  DurablePrimitivesService
>() {}
```

`DurablePrimitivesLive` is currently an identity implementation. It returns the
approval resolution, event payload, timer request, or continue-as-new transition
passed to it. A production driver can replace this layer with a durable backend.

```ts
import { DurablePrimitives } from "@smithers/core/durables";

const approve = Effect.gen(function* () {
  const durables = yield* DurablePrimitives;
  return yield* durables.resolveApproval("review", {
    approved: true,
    decidedBy: "william",
  });
});
```

### ExecutionService

`src/execution/index.ts` defines a small default execution service for compute
and static tasks.

```ts
export type ExecutionInput = {
  readonly task: TaskDescriptor;
  readonly signal?: AbortSignal;
};

export type ExecutionServiceShape = {
  readonly execute: (input: ExecutionInput) => Effect.Effect<TaskOutput>;
};

export class ExecutionService extends Context.Tag("ExecutionService")<
  ExecutionService,
  ExecutionServiceShape
>() {}
```

`ExecutionServiceLive` executes:

- `task.computeFn` through `fromPromise`
- `task.staticPayload` through `fromSync`
- tasks without either as `undefined` output

It normalizes results into `TaskOutput`:

```ts
{
  nodeId: task.nodeId,
  iteration: task.iteration,
  output,
}
```

Use it when a driver wants core to execute compute/static tasks and reserve
agent execution for driver-specific code.

```ts
import { ExecutionService } from "@smithers/core/execution";

const output = await runtime.runPromise(
  Effect.gen(function* () {
    const execution = yield* ExecutionService;
    return yield* execution.execute({ task });
  }),
);
```

### MetricsService

`src/observability/metrics.ts` implements in-memory metrics with Prometheus
rendering.

```ts
export type MetricName = string;
export type MetricLabels = Readonly<Record<string, string | number | boolean>>;
export type MetricsSnapshot = ReadonlyMap<string, MetricEntry>;

export class MetricsService extends Context.Tag("MetricsService")<
  MetricsService,
  {
    readonly increment: (
      name: MetricName,
      labels?: MetricLabels,
    ) => Effect.Effect<void>;

    readonly gauge: (
      name: MetricName,
      value: number,
      labels?: MetricLabels,
    ) => Effect.Effect<void>;

    readonly histogram: (
      name: MetricName,
      value: number,
      labels?: MetricLabels,
    ) => Effect.Effect<void>;

    readonly renderPrometheus: () => Effect.Effect<string>;
    readonly snapshot: () => Effect.Effect<MetricsSnapshot>;
  }
>() {}
```

`MetricEntry` is internal to the metrics module. Treat `MetricsSnapshot` as an
opaque test/debug value unless that entry type is exported later.

Exports:

- `MetricName`
- `MetricLabels`
- `MetricsSnapshot`
- `MetricsService`
- `makeInMemoryMetricsService`
- `MetricsServiceLive`
- `MetricsServiceNoop`

Use it inside Effect code without `runPromise`.

```ts
import { Effect } from "effect";
import { MetricsService } from "@smithers/core";

const recordCacheHit = Effect.gen(function* () {
  const metrics = yield* MetricsService;
  yield* metrics.increment("smithers_cache_hits_total", {
    scope: "workflow",
  });
});
```

Export metrics at the driver boundary:

```ts
const body = await runtime.runPromise(
  Effect.gen(function* () {
    const metrics = yield* MetricsService;
    return yield* metrics.renderPrometheus();
  }),
);
```

Take a snapshot for tests:

```ts
const snapshot = await runtime.runPromise(
  Effect.gen(function* () {
    const metrics = yield* MetricsService;
    return yield* metrics.snapshot();
  }),
);
```

`MetricsServiceLive` uses the in-memory registry. `MetricsServiceNoop` discards
all writes and returns an empty Prometheus document.

### Prometheus Helpers

`src/observability/prometheus.ts` exports low-level Prometheus helpers.

```ts
export type PrometheusSample = {
  readonly name: string;
  readonly type: "counter" | "gauge" | "histogram";
  readonly labels: MetricLabels;
  readonly value?: number;
  readonly buckets?: ReadonlyMap<number, number>;
  readonly sum?: number;
  readonly count?: number;
};

export function toPrometheusMetricName(name: string): string;

export function renderPrometheusSamples(
  samples: readonly PrometheusSample[],
): string;
```

Example:

```ts
const body = renderPrometheusSamples([
  {
    name: "smithers.tasks.started",
    type: "counter",
    labels: { workflow: "demo" },
    value: 1,
  },
]);
```

### TracingService

`TracingService` wraps Effects in spans and annotates the active span.

```ts
import { Context, Effect } from "effect";

export class TracingService extends Context.Tag("TracingService")<
  TracingService,
  {
    readonly withSpan: <A, E, R>(
      name: string,
      effect: Effect.Effect<A, E, R>,
      attributes?: Record<string, unknown>,
    ) => Effect.Effect<A, E, R>;

    readonly annotate: (
      attributes: Record<string, unknown>,
    ) => Effect.Effect<void>;

    readonly withCorrelation: <A, E, R>(
      context: CorrelationPatch,
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E, R>;
  }
>() {}
```

Example:

```ts
const scheduled = Effect.gen(function* () {
  const tracing = yield* TracingService;

  return yield* tracing.withSpan(
    "scheduler.schedule",
    Effect.sync(() =>
      scheduleTasks(plan, states, descriptors, ralphState, retryWait, Date.now()),
    ),
    { runId, taskCount: descriptors.size },
  );
});
```

`TracingServiceLive` uses Effect log spans and span annotations. It also maps
common fields to Smithers attribute names, for example `runId` becomes
`smithers.run_id` and `nodeId` becomes `smithers.node_id`.

### CorrelationContext

Correlation context carries run identity through metrics, traces, logs, and
task execution.

```ts
export type CorrelationContext = {
  readonly runId: string;
  readonly nodeId?: string;
  readonly iteration?: number;
  readonly attempt?: number;
  readonly workflowName?: string;
  readonly parentRunId?: string;
  readonly traceId?: string;
  readonly spanId?: string;
};

export type CorrelationPatch = Partial<CorrelationContext> | undefined | null;
```

Usage:

```ts
const taskEffect = Effect.gen(function* () {
  const tracing = yield* TracingService;

  return yield* tracing.withCorrelation(
    { runId, nodeId: task.nodeId, iteration: task.iteration },
    tracing.withSpan("task.execute", executeTask(task)),
  );
});
```

`src/observability/correlation.ts` exports both Effect and synchronous helpers:

```ts
export const correlationContextFiberRef: FiberRef.FiberRef<
  CorrelationContext | undefined
>;

export class CorrelationContextService extends Context.Tag(
  "CorrelationContextService",
)<
  CorrelationContextService,
  {
    readonly current: () => Effect.Effect<CorrelationContext | undefined>;
    readonly withCorrelation: <A, E, R>(
      patch: CorrelationPatch,
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E, R>;
    readonly toLogAnnotations: (
      context?: CorrelationContext | null,
    ) => Record<string, unknown> | undefined;
  }
>() {}
```

Helpers:

```ts
mergeCorrelationContext(base, patch);
getCurrentCorrelationContext();
runWithCorrelationContext(patch, () => work());
withCorrelationContext(effect, patch);
withCurrentCorrelationContext(effect);
correlationContextToLogAnnotations(context);
```

`CorrelationContextLive` stores context in a FiberRef. The synchronous helpers
also use Node `AsyncLocalStorage` so drivers can bridge non-Effect callbacks
into Effect context.

### StorageService

Drivers implement `StorageService`. The engine uses it for run records, frames,
nodes, attempts, durable waits, and transactions.

```ts
import { Context, Effect } from "effect";

export type Run = {
  readonly runId: string;
  readonly parentRunId?: string | null;
  readonly workflowName?: string | null;
  readonly workflowPath?: string | null;
  readonly status: string;
  readonly createdAtMs?: number;
  readonly startedAtMs?: number | null;
  readonly finishedAtMs?: number | null;
  readonly heartbeatAtMs?: number | null;
  readonly errorJson?: string | null;
  readonly configJson?: string | null;
};

export type RunPatch = Partial<Omit<Run, "runId">>;

export type FrameRow = {
  readonly runId: string;
  readonly frameNo: number;
  readonly xmlJson?: string | null;
  readonly graphJson?: string | null;
  readonly createdAtMs?: number;
};

export type NodeRow = {
  readonly runId: string;
  readonly nodeId: string;
  readonly iteration: number;
  readonly state: string;
  readonly lastAttempt?: number | null;
  readonly updatedAtMs: number;
  readonly outputTable?: string;
  readonly label?: string | null;
};

export type AttemptRow = {
  readonly runId: string;
  readonly nodeId: string;
  readonly iteration: number;
  readonly attempt: number;
  readonly state: string;
  readonly startedAtMs: number;
  readonly finishedAtMs?: number | null;
  readonly heartbeatAtMs?: number | null;
  readonly heartbeatDataJson?: string | null;
  readonly errorJson?: string | null;
  readonly responseText?: string | null;
  readonly cached?: boolean;
  readonly metaJson?: string | null;
};

export type Attempt = AttemptRow;

export type AttemptPatch = Partial<
  Omit<AttemptRow, "runId" | "nodeId" | "iteration" | "attempt">
>;

export type StorageServiceShape = {
  readonly getRun: (runId: string) => Effect.Effect<Run | null>;
  readonly updateRun: (runId: string, patch: RunPatch) => Effect.Effect<void>;
  readonly insertFrame: (frame: FrameRow) => Effect.Effect<void>;
  readonly insertNode: (node: NodeRow) => Effect.Effect<void>;
  readonly insertAttempt: (attempt: AttemptRow) => Effect.Effect<void>;
  readonly updateAttempt: (
    runId: string,
    nodeId: string,
    iteration: number,
    attempt: number,
    patch: AttemptPatch,
  ) => Effect.Effect<void>;
  readonly listAttempts: (
    runId: string,
    nodeId: string,
    iteration: number,
  ) => Effect.Effect<readonly Attempt[]>;
  readonly withTransaction: <A, E, R>(
    label: string,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
};

export class StorageService extends Context.Tag("StorageService")<
  StorageService,
  StorageServiceShape
>() {}
```

The package includes `makeInMemoryStorageService` and `InMemoryStorageLive` for
tests and local drivers.

```ts
import { InMemoryStorageLive } from "@smithers/core/persistence";

const runtime = makeSmithersRuntime(
  SmithersCoreLayer.pipe(Layer.provide(InMemoryStorageLive)),
);
```

Custom storage binds the same shape to a database. Keep `updateAttempt`
identified by `runId`, `nodeId`, `iteration`, and `attempt`; this matches the
attempt primary key used by the in-memory implementation.

```ts
import { Effect, Layer } from "effect";
import {
  StorageService,
  type StorageServiceShape,
} from "@smithers/core/persistence";

export function sqliteStorage(db: Database) {
  const service: StorageServiceShape = {
    getRun: (runId) =>
      Effect.promise(() => db.getRun(runId)),

    updateRun: (runId, patch) =>
      Effect.promise(() => db.updateRun(runId, patch)),

    insertFrame: (frame) =>
      Effect.promise(() => db.insertFrame(frame)),

    insertNode: (node) =>
      Effect.promise(() => db.insertNode(node)),

    insertAttempt: (attempt) =>
      Effect.promise(() => db.insertAttempt(attempt)),

    updateAttempt: (runId, nodeId, iteration, attempt, patch) =>
      Effect.promise(() =>
        db.updateAttempt(runId, nodeId, iteration, attempt, patch),
      ),

    listAttempts: (runId, nodeId, iteration) =>
      Effect.promise(() => db.listAttempts(runId, nodeId, iteration)),

    withTransaction: (_label, effect) =>
      Effect.acquireUseRelease(
        Effect.promise(() => db.begin()),
        () => effect,
        (tx, exit) =>
          exit._tag === "Success"
            ? Effect.promise(() => tx.commit())
            : Effect.promise(() => tx.rollback()),
      ),
  };

  return Layer.succeed(StorageService, service);
}
```

The current source does not encode a `SmithersError` error channel on
`StorageServiceShape`. Session code should still translate backend failures to
public `SmithersError` values before returning an `EngineDecision.Failed`.

### Interop Utilities

`src/interop/index.ts` implements helpers for turning driver-side sync and async
work into typed Effects.

```ts
import {
  fromPromise,
  fromSync,
  ignoreSyncError,
  toError,
} from "@smithers/core/interop";
```

`toError` converts an unknown cause to `SmithersError`.

```ts
const err = toError(new Error("bad input"), "parse config", {
  code: "INVALID_INPUT",
  details: { path: "smithers.json" },
});
```

`fromPromise` wraps a Promise-returning function.

```ts
const readConfig = fromPromise(
  "read config",
  () => fs.promises.readFile("smithers.json", "utf8"),
  { code: "INVALID_INPUT" },
);
```

`fromSync` wraps a throwing synchronous function.

```ts
const parsed = fromSync(
  "parse config",
  () => JSON.parse(raw),
  { code: "INVALID_INPUT" },
);
```

`ignoreSyncError` runs best-effort cleanup and swallows failures.

```ts
const cleanup = ignoreSyncError("close temp file", () => temp.close());
```

### Runtime Factory

`src/runtime/index.ts` provides one managed runtime for implemented core
services.

```ts
import {
  makeSmithersRuntime,
  runFork,
  runPromise,
  runSync,
  SmithersCoreLayer,
} from "@smithers/core/runtime";

const runtime = makeSmithersRuntime(SmithersCoreLayer);
```

Layer composition:

```ts
const ObservabilityLayer = Layer.mergeAll(
  CorrelationContextLive,
  MetricsServiceLive,
  TracingServiceLive,
);

export const SmithersCoreLayer = Layer.mergeAll(
  ObservabilityLayer,
  SchedulerLive.pipe(Layer.provide(ObservabilityLayer)),
  DurablePrimitivesLive,
  ExecutionServiceLive,
  WorkflowSessionLive,
);

export function makeSmithersRuntime(layer = SmithersCoreLayer) {
  return ManagedRuntime.make(layer);
}
```

Convenience runners use a default runtime and decorate logs with
`service = "smithers-core"`.

```ts
const decision = await runPromise(session.submitGraph(graph));
const fiber = runFork(session.submitGraph(graph));
const immediate = runSync(Effect.succeed("ok"));
```

`runPromise` normalizes failures to `SmithersError`. `makeSmithersRuntime`
returns a `ManagedRuntime` for drivers that need direct runtime control.

### Error Types

`src/errors/index.ts` implements the error model.

```ts
export const ERROR_REFERENCE_URL = "https://smithers.sh/reference/errors";

export type EngineErrorCode =
  | "TASK_HEARTBEAT_TIMEOUT"
  | "DUPLICATE_ID"
  | "NESTED_LOOP"
  | "INVALID_CONTINUATION_STATE"
  | "TASK_ID_REQUIRED"
  | "TASK_MISSING_OUTPUT"
  | "WORKTREE_EMPTY_PATH"
  | "INVALID_INPUT"
  | "WORKFLOW_EXECUTION_FAILED"
  | "TASK_TIMEOUT"
  | "TASK_ABORTED"
  | "MISSING_OUTPUT"
  | "DEP_NOT_SATISFIED"
  | "RUN_CANCELLED"
  | "RUN_NOT_FOUND"
  | "NODE_NOT_FOUND"
  | "STORAGE_ERROR"
  | "SCHEDULER_ERROR"
  | "SESSION_ERROR"
  | "INTERNAL_ERROR";

export type SmithersErrorCode = EngineErrorCode;

export type ErrorWrapOptions = {
  readonly code?: SmithersErrorCode;
  readonly details?: Record<string, unknown>;
};
```

`EngineError` is an Effect tagged error for internal failures.

```ts
export class EngineError extends Data.TaggedError("EngineError")<{
  readonly code: EngineErrorCode;
  readonly message: string;
  readonly context?: Record<string, unknown>;
}> {}
```

`SmithersError` is the public error type.

```ts
export class SmithersError extends Error {
  readonly code: SmithersErrorCode;
  readonly summary: string;
  readonly docsUrl: string;
  readonly details?: Record<string, unknown>;
  override readonly cause?: unknown;
}
```

Helpers:

```ts
import {
  EngineError,
  SmithersError,
  errorToJson,
  isSmithersError,
  toSmithersError,
} from "@smithers/core/errors";

const wrapped = toSmithersError(
  new Error("network down"),
  "call agent",
  { code: "WORKFLOW_EXECUTION_FAILED" },
);

if (isSmithersError(wrapped)) {
  console.error(wrapped.code, wrapped.summary, wrapped.docsUrl);
}

const json = errorToJson(wrapped);
```

`toSmithersError` preserves an existing `SmithersError` when no label or
override is passed. It maps `EngineError` codes and context into public
`SmithersError` values.

## Writing a Driver

A driver is a loop that turns decisions into outside-world actions.

### 1. Create a session

```ts
const session = makeWorkflowSession({ runId: "run_1" });
```

### 2. Build a HostNode tree

No React is required.

```ts
const root: HostNode = {
  kind: "element",
  tag: "smithers:workflow",
  props: {},
  rawProps: {},
  children: [
    {
      kind: "element",
      tag: "smithers:task",
      props: { id: "collect" },
      rawProps: {
        id: "collect",
        output: "collections",
        __smithersKind: "compute",
        __smithersComputeFn: () => ({ count: 3 }),
      },
      children: [{ kind: "text", text: "Collect input" }],
    },
  ],
};
```

### 3. Extract a graph

```ts
const graph = extractGraph(root);
```

### 4. Submit the graph

```ts
let decision = await runtime.runPromise(session.submitGraph(graph));
```

### 5. Handle decisions

```ts
while (true) {
  switch (decision._tag) {
    case "Execute":
      // run tasks and report completion or failure
      break;
    case "ReRender":
      // build a new HostNode tree from decision.context
      break;
    case "Wait":
      // wait externally, then call back into the session
      break;
    case "Finished":
      return decision.result;
    case "Failed":
      throw decision.error;
  }
}
```

### 6. Report task completions and failures

```ts
try {
  const output = await executeTask(task);

  decision = await runtime.runPromise(
    session.taskCompleted({
      nodeId: task.nodeId,
      iteration: task.iteration,
      output,
    }),
  );
} catch (error) {
  decision = await runtime.runPromise(
    session.taskFailed({
      nodeId: task.nodeId,
      iteration: task.iteration,
      error,
    }),
  );
}
```

### Minimal Programmatic Driver

This is the complete shape of a non-React driver.

```ts
import {
  extractGraph,
  makeWorkflowSession,
  makeSmithersRuntime,
  type EngineDecision,
  type HostNode,
  type TaskDescriptor,
  type WorkflowSessionService,
} from "@smithers/core";

const runtime = makeSmithersRuntime();

function buildGraph(): HostNode {
  return {
    kind: "element",
    tag: "smithers:workflow",
    props: {},
    rawProps: {},
    children: [
      {
        kind: "element",
        tag: "smithers:task",
        props: { id: "hello" },
        rawProps: {
          id: "hello",
          output: "greetings",
          __smithersKind: "compute",
          __smithersComputeFn: () => ({ message: "hello" }),
        },
        children: [{ kind: "text", text: "Create a greeting" }],
      },
    ],
  };
}

async function executeTask(task: TaskDescriptor): Promise<unknown> {
  if (task.computeFn) return await task.computeFn();
  if (task.staticPayload !== undefined) return task.staticPayload;
  throw new Error(`No executor for task ${task.nodeId}`);
}

async function step(
  session: WorkflowSessionService,
  decision: EngineDecision,
): Promise<EngineDecision> {
  switch (decision._tag) {
    case "Execute": {
      let next = decision;
      for (const task of decision.tasks) {
        try {
          const output = await executeTask(task);
          next = await runtime.runPromise(
            session.taskCompleted({
              nodeId: task.nodeId,
              iteration: task.iteration,
              output,
            }),
          );
        } catch (error) {
          next = await runtime.runPromise(
            session.taskFailed({
              nodeId: task.nodeId,
              iteration: task.iteration,
              error,
            }),
          );
        }
      }
      return next;
    }
    case "ReRender":
      return await runtime.runPromise(
        session.submitGraph(extractGraph(buildGraph())),
      );
    case "Wait":
      throw new Error(`Unhandled wait: ${decision.reason._tag}`);
    case "ContinueAsNew":
      throw new Error("Continue-as-new is not implemented in this driver");
    case "Finished":
    case "Failed":
      return decision;
  }
}

export async function main() {
  const session = makeWorkflowSession({ runId: "demo" });

  let decision = await runtime.runPromise(
    session.submitGraph(extractGraph(buildGraph())),
  );

  while (decision._tag !== "Finished" && decision._tag !== "Failed") {
    decision = await step(session, decision);
  }

  if (decision._tag === "Failed") throw decision.error;
  return decision.result;
}
```

Real drivers add:

- A storage layer.
- Task executors for agents, static payloads, and compute functions.
- Approval and event adapters.
- Timer handling.
- Logging, metrics export, and trace export.

## Observability

### Define Metrics

Use stable names and low-cardinality labels.

```ts
const metrics = {
  runsStarted: "smithers_runs_started_total",
  tasksStarted: "smithers_tasks_started_total",
  taskDuration: "smithers_task_duration_ms",
  runnableTasks: "smithers_runnable_tasks",
} as const;
```

### Record Metrics

Record metrics inside Effect code.

```ts
const markTaskStarted = (task: TaskDescriptor) =>
  Effect.gen(function* () {
    const m = yield* MetricsService;
    yield* m.increment(metrics.tasksStarted, {
      nodeId: task.nodeId,
    });
  });
```

Do not do this inside core:

```ts
void runtime.runPromise(markTaskStarted(task));
```

Return the Effect and let the caller compose it.

### Export Prometheus

Expose a driver endpoint or command that runs one Effect.

```ts
export async function metricsEndpoint() {
  return await runtime.runPromise(
    Effect.gen(function* () {
      const m = yield* MetricsService;
      return yield* m.renderPrometheus();
    }),
  );
}
```

### Trace Spans

Wrap meaningful operations, not every helper.

```ts
const submitGraphTraced = (graph: WorkflowGraph) =>
  Effect.gen(function* () {
    const tracing = yield* TracingService;
    return yield* tracing.withSpan(
      "session.submit_graph",
      session.submitGraph(graph),
      { taskCount: graph.tasks.length },
    );
  });
```

### Propagate Correlation Context

Use correlation context at run, node, and attempt boundaries.

```ts
const runAttempt = (task: TaskDescriptor, attempt: number) =>
  Effect.gen(function* () {
    const tracing = yield* TracingService;

    return yield* tracing.withCorrelation(
      {
        runId,
        workflowName,
        nodeId: task.nodeId,
        iteration: task.iteration,
        attempt,
      },
      tracing.withSpan("task.attempt", executeTaskEffect(task)),
    );
  });
```

## Persistence

Storage is driver-provided. Core defines the interface; drivers bind it to a
backend.

A storage implementation should:

- Store runs by `runId`.
- Insert immutable graph frames.
- Upsert node state by `runId`, `nodeId`, and `iteration`.
- Insert and update attempts by `runId`, `nodeId`, `iteration`, and `attempt`.
- Support transactional frame commits.
- Avoid leaking backend-specific errors into engine decisions.

Use the built-in memory storage for tests:

```ts
import {
  InMemoryStorageLive,
  makeInMemoryStorageService,
} from "@smithers/core/persistence";

const storage = makeInMemoryStorageService();

await Effect.runPromise(
  storage.updateRun("run_1", {
    status: "running",
    workflowName: "demo",
  }),
);
```

A production implementation should make `withTransaction` real. Frame insert,
node updates, attempt updates, and run status changes must commit together when
the engine treats them as one state transition.

## Architecture

### Package Structure

Target structure:

```text
src/
  session/          WorkflowSession, WorkflowSessionService, makeWorkflowSession
  scheduler/        task scheduling, plan tree, concurrency limits
  graph/            HostNode types and extractGraph
  state/            task state machine helpers
  persistence/      frame commits, snapshots, attempts
  observability/    MetricsService, TracingService, CorrelationContext
  durables/         approvals, timers, events, continue-as-new
  execution/        retry, cache, heartbeat watchdog
  interop/          Effect <-> Promise bridge utilities
  runtime/          unified ManagedRuntime factory
  errors/           SmithersError and EngineError
```

Current checked-in source:

```text
src/
  durables/index.ts
  errors/index.ts
  execution/index.ts
  graph/extract.ts
  graph/index.ts
  graph/types.ts
  index.ts
  interop/index.ts
  observability/correlation.ts
  observability/index.ts
  observability/metrics.ts
  observability/prometheus.ts
  observability/tracing.ts
  persistence/index.ts
  runtime/index.ts
  scheduler/index.ts
  session/index.ts
  session/types.ts
  state/index.ts
```

### Dependency Graph

Package dependency:

```text
@smithers/core
  peer: effect
  dev: typescript, bun types
```

Runtime dependency flow:

```text
driver
  creates ManagedRuntime
  creates WorkflowSessionService
  builds HostNode tree
  calls extractGraph
  submits WorkflowGraph

WorkflowSession
  uses scheduler
  uses task state helpers
  uses error helpers
  returns EngineDecision

SmithersCoreLayer
  provides observability
  provides scheduler service
  provides durable primitive service
  provides execution service
  provides workflow session service

driver
  executes EngineDecision
  reports results back to WorkflowSessionService
```

`persistence` is exported, but the current `WorkflowSession` implementation does
not wire `StorageService` into state transitions yet.

There is no React dependency in this graph.

### Relation To @smithers/core-react

`@smithers/core-react` is a driver package. It should:

- Render workflow JSX.
- Build `HostNode` trees through its reconciler.
- Call `extractGraph`.
- Create a `WorkflowSessionService`.
- Submit graphs and task outcomes.
- Execute tasks and prompts using its React-specific facilities.

It should not own:

- Scheduling.
- Retry policy.
- Durable approvals and timers.
- Persistence semantics.
- Metrics or tracing internals.
- Task state transitions.

React builds data. `@smithers/core` interprets it.

### Single ManagedRuntime

The core uses one runtime layer. Services compose through `Layer`; internals
return Effects.

```ts
const CoreLayer = Layer.mergeAll(
  CorrelationContextLive,
  MetricsServiceLive,
  TracingServiceLive,
  SchedulerLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        CorrelationContextLive,
        MetricsServiceLive,
        TracingServiceLive,
      ),
    ),
  ),
  DurablePrimitivesLive,
  ExecutionServiceLive,
  WorkflowSessionLive,
);
```

The driver calls `runtime.runPromise` around session methods.

```ts
const decision = await runtime.runPromise(session.submitGraph(graph));
```

Core services do not call `runPromise` to record metrics, write storage, or
start traces. They return Effects that are run by the single driver-owned
runtime boundary.

## Driver Checklist

Use this checklist when writing a new driver:

- Provide a `StorageService` layer.
- Create one managed runtime.
- Create one `WorkflowSessionService` per workflow run.
- Build `HostNode` trees without importing core-internal modules.
- Call `extractGraph`.
- Submit the graph.
- Switch on every `EngineDecision` variant.
- Execute all tasks from `Execute`.
- Report every task completion or failure with `nodeId` and `iteration`.
- Re-render on `ReRender` and submit the new graph.
- Wait outside core for approvals, events, timers, and retry backoff.
- Export metrics and traces from the driver boundary.
- Treat `Failed` as terminal.
- Treat `Finished` as terminal.
