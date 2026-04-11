import type { Effect } from "effect";
import type { ApprovalResolution, ContinueAsNewTransition } from "../durables/index.ts";
import type { SmithersError } from "../errors/index.ts";
import type { TaskDescriptor, WorkflowGraph } from "../graph/types.ts";
import type { ScheduleSnapshot } from "../scheduler/index.ts";
import type { TaskStateMap } from "../state/index.ts";

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

export type RunResult = {
  readonly runId: string;
  readonly status:
    | "running"
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

export type RenderContext = {
  readonly runId: string;
  readonly graph: WorkflowGraph | null;
  readonly iteration?: number;
  readonly taskStates: TaskStateMap;
  readonly outputs: ReadonlyMap<string, TaskOutput>;
  readonly ralphIterations: ReadonlyMap<string, number>;
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
  | {
      readonly _tag: "Wait";
      readonly reason: WaitReason;
    }
  | {
      readonly _tag: "ContinueAsNew";
      readonly transition: ContinueAsNewTransition;
    }
  | { readonly _tag: "Finished"; readonly result: RunResult }
  | { readonly _tag: "Failed"; readonly error: SmithersError };

export type WorkflowSessionService = {
  readonly submitGraph: (graph: WorkflowGraph) => Effect.Effect<EngineDecision>;
  readonly taskCompleted: (output: TaskOutput) => Effect.Effect<EngineDecision>;
  readonly taskFailed: (failure: TaskFailure) => Effect.Effect<EngineDecision>;
  readonly approvalResolved: (
    nodeId: string,
    resolution: ApprovalResolution,
  ) => Effect.Effect<EngineDecision>;
  readonly approvalTimedOut: (nodeId: string) => Effect.Effect<EngineDecision>;
  readonly eventReceived: (
    eventName: string,
    payload: unknown,
    correlationId?: string | null,
  ) => Effect.Effect<EngineDecision>;
  readonly signalReceived: (
    signalName: string,
    payload: unknown,
    correlationId?: string | null,
  ) => Effect.Effect<EngineDecision>;
  readonly timerFired: (
    nodeId: string,
    firedAtMs?: number,
  ) => Effect.Effect<EngineDecision>;
  readonly hotReloaded: (graph: WorkflowGraph) => Effect.Effect<EngineDecision>;
  readonly heartbeatTimedOut: (
    nodeId: string,
    iteration?: number,
    details?: Record<string, unknown>,
  ) => Effect.Effect<EngineDecision>;
  readonly cacheResolved: (
    output: TaskOutput,
    cached: boolean,
  ) => Effect.Effect<EngineDecision>;
  readonly cacheMissed: (
    nodeId: string,
    iteration?: number,
  ) => Effect.Effect<EngineDecision>;
  readonly recoverOrphanedTasks: () => Effect.Effect<EngineDecision>;
  readonly cancelRequested: () => Effect.Effect<EngineDecision>;
  readonly getTaskStates: () => Effect.Effect<TaskStateMap>;
  readonly getSchedule: () => Effect.Effect<ScheduleSnapshot | null>;
  readonly getCurrentGraph: () => Effect.Effect<WorkflowGraph | null>;
};
