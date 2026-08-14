// @smithers-type-exports-begin
/** @typedef {import("./ContinuationRequest.ts").ContinuationRequest} ContinuationRequest */
/** @typedef {import("./PlanNode.ts").PlanNode} PlanNode */
/** @typedef {import("./RalphMeta.ts").RalphMeta} RalphMeta */
/** @typedef {import("./RalphState.ts").RalphState} RalphState */
/** @typedef {import("./RalphStateMap.ts").RalphStateMap} RalphStateMap */
/** @typedef {import("@smthrs/scheduler").ReadonlyTaskStateMap} ReadonlyTaskStateMap */
/** @typedef {import("@smthrs/scheduler").RetryWaitMap} RetryWaitMap */
/** @typedef {import("./ScheduleResult.ts").ScheduleResult} ScheduleResult */
/** @typedef {import("@smthrs/scheduler").ScheduleSnapshot} ScheduleSnapshot */
/** @typedef {import("@smthrs/scheduler").TaskRecord} TaskRecord */
/** @typedef {import("@smthrs/scheduler").TaskState} TaskState */
/** @typedef {import("@smthrs/scheduler").TaskStateMap} TaskStateMap */
/** @typedef {import("@smthrs/graph/TaskDescriptor").TaskDescriptor} _TaskDescriptor */
/** @typedef {import("@smthrs/graph/XmlNode").XmlNode} XmlNode */
// @smithers-type-exports-end

import { buildPlanTree as coreBuildPlanTree, scheduleTasks as coreScheduleTasks } from "@smthrs/scheduler";
export { buildStateKey } from "@smthrs/scheduler";
export { Scheduler, SchedulerLive } from "@smthrs/scheduler";
export { cloneTaskStateMap, isTerminalState, parseStateKey } from "@smthrs/scheduler";

/**
 * @type {(xml: XmlNode | null, ralphState?: RalphStateMap) => { plan: PlanNode | null; ralphs: RalphMeta[] }}
 */
export const buildPlanTree = coreBuildPlanTree;

/**
 * @type {(plan: PlanNode | null, states: TaskStateMap, descriptors: Map<string, _TaskDescriptor>, ralphState: RalphStateMap, retryWait: Map<string, number>, nowMs: number) => ScheduleResult}
 */
export const scheduleTasks = coreScheduleTasks;
