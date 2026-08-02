import { Context } from "effect";
/** @typedef {import("@smthrs/graph").TaskDescriptor} TaskDescriptor */
/** @typedef {import("./TaskStateMap.ts").TaskStateMap} TaskStateMap */
/** @typedef {import("./PlanNode.ts").PlanNode} PlanNode */
/** @typedef {import("./RalphStateMap.ts").RalphStateMap} RalphStateMap */
/** @typedef {import("./RetryWaitMap.ts").RetryWaitMap} RetryWaitMap */
/** @typedef {import("./ScheduleResult.ts").ScheduleResult} ScheduleResult */

/**
 * @typedef {{
 *   readonly schedule: (
 *     plan: PlanNode | null,
 *     states: TaskStateMap,
 *     descriptors: Map<string, TaskDescriptor>,
 *     ralphState: RalphStateMap,
 *     retryWait: RetryWaitMap,
 *     nowMs: number,
 *     taskFailures?: ReadonlyMap<string, unknown>,
 *   ) => import("effect").Effect.Effect<ScheduleResult>
 * }} SchedulerService
 */

const SchedulerBase = /** @type {Context.ServiceClass<Scheduler, "Scheduler", SchedulerService>} */ (
  /** @type {unknown} */ (Context.Service("Scheduler"))
);

export class Scheduler extends SchedulerBase {}
