import type { WorkflowGraph } from "@smithers-orchestrator/graph";
import type { TaskOutput } from "./TaskOutput.ts";

export type RenderTriggerReason =
  | "task-finished"
  | "timer-fired"
  | "cache-resolved"
  | "loop-advanced"
  | "deadlock-check"
  | "stability-check"
  | (string & {});

export type RenderTrigger = {
  readonly reason: RenderTriggerReason;
  readonly nodeId?: string;
  readonly iteration?: number;
};

export type RenderContext = {
  readonly runId: string;
  readonly graph?: WorkflowGraph | null;
  readonly iteration?: number;
  readonly iterations?: Record<string, number> | ReadonlyMap<string, number>;
  readonly input?: unknown;
  readonly outputs?: Record<string, unknown[]> | ReadonlyMap<string, TaskOutput>;
  readonly auth?: unknown;
  readonly taskStates?: unknown;
  readonly ralphIterations?: ReadonlyMap<string, number>;
  readonly trigger?: RenderTrigger;
};
