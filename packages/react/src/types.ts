import type React from "react";
import type { z } from "zod";
import type { SchemaRegistryEntry } from "./SchemaRegistryEntry";
import type { SmithersCtx } from "./SmithersCtx";
import type { SmithersWorkflowOptions } from "./SmithersWorkflowOptions";
import type { RunOptions } from "./RunOptions";
import type { RunResult } from "./RunResult";
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
} from "./core-types";

export type SmithersWorkflow<Schema = unknown> = {
  db?: unknown;
  build: (ctx: SmithersCtx<Schema>) => React.ReactElement;
  opts: SmithersWorkflowOptions;
  schemaRegistry?: Map<string, SchemaRegistryEntry>;
  zodToKeyName?: Map<z.ZodObject<any>, string>;
};

export type SmithersWorkflowDriverOptions<Schema = unknown> = {
  workflow: SmithersWorkflow<Schema>;
  runtime: WorkflowRuntime;
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
  renderer?: {
    render(
      element: React.ReactElement,
      opts?: ExtractOptions,
    ): Promise<WorkflowGraph> | WorkflowGraph;
  };
};

export type WorkflowRuntime = {
  runPromise<A>(effect: unknown): Promise<A>;
};

export type CreateWorkflowSession = (
  opts: CreateWorkflowSessionOptions,
) => unknown;

export type CreateWorkflowSessionOptions = {
  db?: unknown;
  runId: string;
  rootDir?: string;
  workflowPath?: string | null;
  options: RunOptions;
};

export type WorkflowSession = {
  submitGraph(graph: WorkflowGraph): unknown;
  taskCompleted(event: TaskCompletedEvent): unknown;
  taskFailed(event: TaskFailedEvent): unknown;
  getNextDecision?(): unknown;
  cancelRequested?(): unknown;
};

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

export type RenderContext = {
  runId: string;
  iteration?: number;
  iterations?: Record<string, number>;
  input?: unknown;
  outputs?: Record<string, unknown[]> | ReadonlyMap<string, TaskOutput>;
  auth?: unknown;
  graph?: WorkflowGraph | null;
  taskStates?: unknown;
  ralphIterations?: ReadonlyMap<string, number>;
};

export type EngineDecision =
  | { _tag: "Execute"; tasks: readonly TaskDescriptor[] }
  | { _tag: "ReRender"; context: RenderContext }
  | { _tag: "Wait"; reason: WaitReason }
  | { _tag: "ContinueAsNew"; transition: unknown }
  | { _tag: "Finished"; result: RunResult }
  | { _tag: "Failed"; error: unknown };

export type WaitReason =
  | { readonly _tag: "Approval"; readonly nodeId: string }
  | { readonly _tag: "Event"; readonly eventName: string }
  | { readonly _tag: "Timer"; readonly resumeAtMs: number }
  | { readonly _tag: "RetryBackoff"; readonly waitMs: number }
  | { readonly _tag: "ExternalTrigger" };

export type TaskExecutor = (
  task: TaskDescriptor,
  context: TaskExecutorContext,
) => Promise<unknown> | unknown;

export type TaskExecutorContext = {
  runId: string;
  options: RunOptions;
  signal?: AbortSignal;
};

export type SchedulerWaitHandler = (
  durationMs: number,
  context: { runId: string; tasks: readonly TaskDescriptor[] },
) => Promise<void> | void;

export type TaskOutput = {
  readonly nodeId: string;
  readonly iteration: number;
  readonly output: unknown;
  readonly text?: string | null;
  readonly usage?: Record<string, unknown> | null;
};

export type WaitHandler = (
  reason: WaitReason,
  context: { runId: string; options: RunOptions },
) => Promise<EngineDecision | RunResult> | EngineDecision | RunResult;

export type ContinueAsNewHandler = (
  transition: unknown,
  context: { runId: string; options: RunOptions },
) => Promise<RunResult> | RunResult;

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
