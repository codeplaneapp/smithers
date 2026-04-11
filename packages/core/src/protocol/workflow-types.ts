import type { z } from "zod";
import type {
  ExtractOptions,
  HostElement,
  HostNode,
  HostText,
  TaskDescriptor,
  WorkflowGraph,
  XmlElement,
  XmlNode,
  XmlText,
} from "@smithers/graph/types";
import type { RunOptions } from "./RunOptions";
import type { RunResult } from "./RunResult";
import type { SchemaRegistryEntry } from "./SchemaRegistryEntry";
import type { SmithersCtx } from "./SmithersCtx";
import type { SmithersWorkflowOptions } from "./SmithersWorkflowOptions";

export type WorkflowRuntime = {
  runPromise<A>(effect: unknown): Promise<A>;
};

export type TaskOutput = {
  readonly nodeId: string;
  readonly iteration: number;
  readonly output: unknown;
  readonly text?: string | null;
  readonly usage?: Record<string, unknown> | null;
};

export type RenderContext = {
  readonly runId: string;
  readonly iteration?: number;
  readonly iterations?: Record<string, number> | ReadonlyMap<string, number>;
  readonly input?: unknown;
  readonly outputs?: Record<string, unknown[]> | ReadonlyMap<string, TaskOutput>;
  readonly auth?: unknown;
  readonly graph?: WorkflowGraph | null;
  readonly taskStates?: unknown;
  readonly ralphIterations?: ReadonlyMap<string, number>;
};

export type WaitReason =
  | { readonly _tag: "Approval"; readonly nodeId: string }
  | { readonly _tag: "Event"; readonly eventName: string }
  | { readonly _tag: "Timer"; readonly resumeAtMs: number }
  | { readonly _tag: "RetryBackoff"; readonly waitMs: number }
  | { readonly _tag: "HotReload" }
  | { readonly _tag: "OrphanRecovery"; readonly count: number }
  | { readonly _tag: "ExternalTrigger" };

export type EngineDecision =
  | { readonly _tag: "Execute"; readonly tasks: readonly TaskDescriptor[] }
  | { readonly _tag: "ReRender"; readonly context: RenderContext }
  | { readonly _tag: "Wait"; readonly reason: WaitReason }
  | { readonly _tag: "ContinueAsNew"; readonly transition: unknown }
  | { readonly _tag: "Finished"; readonly result: RunResult }
  | { readonly _tag: "Failed"; readonly error: unknown };

export type TaskCompletedEvent = {
  nodeId: string;
  iteration: number;
  output: unknown;
};

export type TaskFailedEvent = {
  nodeId: string;
  iteration: number;
  error: unknown;
};

export type WorkflowSession = {
  submitGraph(graph: WorkflowGraph): unknown;
  taskCompleted(event: TaskCompletedEvent): unknown;
  taskFailed(event: TaskFailedEvent): unknown;
  getNextDecision?(): unknown;
  cancelRequested?(): unknown;
};

export type CreateWorkflowSessionOptions = {
  db?: unknown;
  runId: string;
  rootDir?: string;
  workflowPath?: string | null;
  options: RunOptions;
};

export type CreateWorkflowSession = (
  opts: CreateWorkflowSessionOptions,
) => unknown;

export type TaskExecutorContext = {
  runId: string;
  options: RunOptions;
  signal?: AbortSignal;
};

export type TaskExecutor = (
  task: TaskDescriptor,
  context: TaskExecutorContext,
) => Promise<unknown> | unknown;

export type SchedulerWaitHandler = (
  durationMs: number,
  context: { runId: string; tasks: readonly TaskDescriptor[] },
) => Promise<void> | void;

export type WaitHandler = (
  reason: WaitReason,
  context: { runId: string; options: RunOptions },
) => Promise<EngineDecision | RunResult> | EngineDecision | RunResult;

export type ContinueAsNewHandler = (
  transition: unknown,
  context: { runId: string; options: RunOptions },
) => Promise<RunResult> | RunResult;

export type Workflow<Schema = unknown, Element = unknown> = {
  db?: unknown;
  build: (ctx: SmithersCtx<Schema>) => Element;
  opts: SmithersWorkflowOptions;
  schemaRegistry?: Map<string, SchemaRegistryEntry>;
  zodToKeyName?: Map<z.ZodObject<any>, string>;
};

export type WorkflowDriverOptions<Schema = unknown, Element = unknown> = {
  workflow: Workflow<Schema, Element>;
  runtime: WorkflowRuntime;
  renderer?: {
    render(
      element: Element,
      opts?: ExtractOptions,
    ): Promise<WorkflowGraph> | WorkflowGraph;
  };
  session?: WorkflowSession;
  createSession?: CreateWorkflowSession;
  db?: unknown;
  runId?: string;
  rootDir?: string;
  workflowPath?: string | null;
  executeTask?: TaskExecutor;
  onSchedulerWait?: SchedulerWaitHandler;
  onWait?: WaitHandler;
  continueAsNew?: ContinueAsNewHandler;
};

export type {
  ExtractOptions,
  HostElement,
  HostNode,
  HostText,
  RunOptions,
  RunResult,
  SmithersCtx,
  SmithersWorkflowOptions,
  TaskDescriptor,
  WorkflowGraph,
  XmlElement,
  XmlNode,
  XmlText,
};
