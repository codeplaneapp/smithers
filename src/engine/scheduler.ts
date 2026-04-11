import {
  buildPlanTree as coreBuildPlanTree,
  scheduleTasks as coreScheduleTasks,
} from "@smithers/core/scheduler";
import type { TaskStateMap } from "@smithers/core/state";
import type { TaskDescriptor } from "../TaskDescriptor";
import type { XmlNode } from "../XmlNode";

export { buildStateKey } from "@smithers/core/scheduler";
export { Scheduler, SchedulerLive } from "@smithers/core/scheduler";
export {
  cloneTaskStateMap,
  isTerminalState,
  parseStateKey,
} from "@smithers/core/state";
export type {
  ReadonlyTaskStateMap,
  TaskRecord,
  TaskState,
  TaskStateMap,
} from "@smithers/core/state";
export type { RetryWaitMap, ScheduleSnapshot } from "@smithers/core/scheduler";

// TODO(migration): Re-export scheduler types directly once src/TaskDescriptor.ts
// can use @smithers/core/graph and engine Ralph state no longer needs
// the legacy mutable compatibility surface.
export type PlanNode =
  | { kind: "task"; nodeId: string }
  | { kind: "sequence"; children: PlanNode[] }
  | { kind: "parallel"; children: PlanNode[] }
  | {
      kind: "ralph";
      id: string;
      children: PlanNode[];
      until: boolean;
      maxIterations: number;
      onMaxReached: "fail" | "return-last";
      continueAsNewEvery?: number;
    }
  | {
      kind: "continue-as-new";
      stateJson?: string;
    }
  | { kind: "group"; children: PlanNode[] }
  | {
      kind: "saga";
      id: string;
      actionChildren: PlanNode[];
      compensationChildren: PlanNode[];
      onFailure: "compensate" | "compensate-and-fail" | "fail";
    }
  | {
      kind: "try-catch-finally";
      id: string;
      tryChildren: PlanNode[];
      catchChildren: PlanNode[];
      finallyChildren: PlanNode[];
    };

export type ScheduleResult = {
  runnable: TaskDescriptor[];
  pendingExists: boolean;
  waitingApprovalExists: boolean;
  waitingEventExists: boolean;
  waitingTimerExists: boolean;
  readyRalphs: RalphMeta[];
  continuation?: ContinuationRequest;
  nextRetryAtMs?: number;
  fatalError?: string;
};

export type RalphMeta = {
  id: string;
  until: boolean;
  maxIterations: number;
  onMaxReached: "fail" | "return-last";
  continueAsNewEvery?: number;
};

export type ContinuationRequest = {
  stateJson?: string;
};

export type RalphState = {
  iteration: number;
  done: boolean;
};

export type RalphStateMap = Map<string, RalphState>;

type BuildPlanTree = (
  xml: XmlNode | null,
  ralphState?: RalphStateMap,
) => {
  plan: PlanNode | null;
  ralphs: RalphMeta[];
};

type ScheduleTasks = (
  plan: PlanNode | null,
  states: TaskStateMap,
  descriptors: Map<string, TaskDescriptor>,
  ralphState: RalphStateMap,
  retryWait: Map<string, number>,
  nowMs: number,
) => ScheduleResult;

export const buildPlanTree = coreBuildPlanTree as unknown as BuildPlanTree;
export const scheduleTasks = coreScheduleTasks as unknown as ScheduleTasks;
