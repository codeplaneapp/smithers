import * as effect from 'effect';
import { Effect, Context, Layer, Schedule as Schedule$1 } from 'effect';
import * as _smithers_orchestrator_graph from '@smithers-orchestrator/graph';
import { TaskDescriptor as TaskDescriptor$3, WorkflowGraph } from '@smithers-orchestrator/graph';
import { TaskDescriptor as TaskDescriptor$4 } from '@smithers-orchestrator/graph/TaskDescriptor';

type TaskState$2 = "pending" | "waiting-approval" | "waiting-event" | "waiting-timer" | "waiting-quota" | "in-progress" | "finished" | "failed" | "cancelled" | "skipped";

type TaskStateMap$4 = Map<string, TaskState$2>;

type ApprovalResolution$1 = {
    readonly approved: boolean;
    readonly note?: string;
    readonly decidedBy?: string;
    readonly optionKey?: string;
    readonly payload?: unknown;
};

type PlanNode$4 = {
    readonly kind: "task";
    readonly nodeId: string;
} | {
    readonly kind: "sequence";
    readonly children: readonly PlanNode$4[];
} | {
    readonly kind: "parallel";
    readonly children: readonly PlanNode$4[];
} | {
    readonly kind: "ralph";
    readonly id: string;
    readonly children: readonly PlanNode$4[];
    readonly until: boolean;
    readonly maxIterations: number;
    readonly onMaxReached: "fail" | "return-last";
    readonly continueAsNewEvery?: number;
} | {
    readonly kind: "continue-as-new";
    readonly stateJson?: string;
} | {
    readonly kind: "group";
    readonly children: readonly PlanNode$4[];
} | {
    readonly kind: "saga";
    readonly id: string;
    readonly actionChildren: readonly PlanNode$4[];
    readonly compensationChildren: readonly PlanNode$4[];
    readonly onFailure: "compensate" | "compensate-and-fail" | "fail";
} | {
    readonly kind: "try-catch-finally";
    readonly id: string;
    readonly tryChildren: readonly PlanNode$4[];
    readonly catchChildren: readonly PlanNode$4[];
    readonly finallyChildren: readonly PlanNode$4[];
};

type ContinuationRequest$1 = {
    readonly stateJson?: string;
};

type RalphMeta$2 = {
    readonly id: string;
    readonly until: boolean;
    readonly maxIterations: number;
    readonly onMaxReached: "fail" | "return-last";
    readonly continueAsNewEvery?: number;
};

type ScheduleResult$3 = {
    readonly runnable: readonly TaskDescriptor$3[];
    readonly pendingExists: boolean;
    readonly waitingApprovalExists: boolean;
    readonly waitingEventExists: boolean;
    readonly waitingTimerExists: boolean;
    readonly readyRalphs: readonly RalphMeta$2[];
    readonly continuation?: ContinuationRequest$1;
    readonly nextRetryAtMs?: number;
    readonly fatalError?: string;
    readonly failureRecoveryActive?: boolean;
    readonly failureRecoveryKeys?: readonly string[];
};

type ScheduleSnapshot$1 = {
    readonly plan: PlanNode$4 | null;
    readonly result: ScheduleResult$3;
    readonly computedAtMs: number;
};

type ContinueAsNewTransition$1 = {
    readonly reason: "explicit" | "loop-threshold" | "driver";
    readonly iteration?: number;
    readonly statePayload?: unknown;
    readonly stateJson?: string;
    readonly newRunId?: string;
    readonly carriedStateBytes?: number;
    readonly ancestryDepth?: number;
};

type TokenUsage$1 = {
    readonly inputTokens?: number;
    readonly outputTokens?: number;
    readonly cacheReadTokens?: number;
    readonly cacheWriteTokens?: number;
    readonly reasoningTokens?: number;
    readonly totalTokens?: number;
    readonly [key: string]: unknown;
};

type TaskOutput$1 = {
    readonly nodeId: string;
    readonly iteration: number;
    readonly output: unknown;
    readonly text?: string | null;
    readonly usage?: TokenUsage$1 | null;
};

type RenderTriggerReason = "task-finished" | "timer-fired" | "cache-resolved" | "loop-advanced" | "deadlock-check" | "stability-check" | (string & {});
type RenderTrigger = {
    readonly reason: RenderTriggerReason;
    readonly nodeId?: string;
    readonly iteration?: number;
};
type RenderContext$1 = {
    readonly runId: string;
    readonly graph?: WorkflowGraph | null;
    readonly iteration?: number;
    readonly iterations?: Record<string, number> | ReadonlyMap<string, number>;
    readonly input?: unknown;
    readonly outputs?: Record<string, unknown[]> | ReadonlyMap<string, TaskOutput$1>;
    readonly auth?: unknown;
    readonly taskStates?: unknown;
    readonly ralphIterations?: ReadonlyMap<string, number>;
    readonly trigger?: RenderTrigger;
};

type RunResult$1 = {
    readonly runId: string;
    readonly status: "running" | "finished" | "failed" | "cancelled" | "continued" | "waiting-approval" | "waiting-event" | "waiting-timer" | "waiting-quota";
    readonly output?: unknown;
    readonly error?: unknown;
    readonly nextRunId?: string;
};

type WaitReason$1 = {
    readonly _tag: "Approval";
    readonly nodeId: string;
} | {
    readonly _tag: "Event";
    readonly eventName: string;
} | {
    readonly _tag: "Timer";
    readonly resumeAtMs: number;
} | {
    readonly _tag: "RetryBackoff";
    readonly waitMs: number;
} | {
    readonly _tag: "HotReload";
} | {
    readonly _tag: "OrphanRecovery";
    readonly count: number;
} | {
    readonly _tag: "ExternalTrigger";
} | {
    readonly _tag: "Quota";
    readonly quotaBlockedCount: number;
    readonly resetAtMs?: number;
};

type EngineDecision$1 = {
    readonly _tag: "Execute";
    readonly tasks: readonly TaskDescriptor$3[];
} | {
    readonly _tag: "ReRender";
    readonly context: RenderContext$1;
} | {
    readonly _tag: "Wait";
    readonly reason: WaitReason$1;
} | {
    readonly _tag: "ContinueAsNew";
    readonly transition: ContinueAsNewTransition$1;
} | {
    readonly _tag: "Finished";
    readonly result: RunResult$1;
} | {
    readonly _tag: "Failed";
    readonly error: unknown;
};

type TaskFailure$1 = {
    readonly nodeId: string;
    readonly iteration: number;
    readonly error: unknown;
};

type WorkflowSessionService$2 = {
    readonly submitGraph: (graph: WorkflowGraph) => Effect.Effect<EngineDecision$1>;
    readonly taskCompleted: (output: TaskOutput$1) => Effect.Effect<EngineDecision$1>;
    readonly taskFailed: (failure: TaskFailure$1) => Effect.Effect<EngineDecision$1>;
    readonly approvalResolved: (nodeId: string, resolution: ApprovalResolution$1) => Effect.Effect<EngineDecision$1>;
    readonly approvalTimedOut: (nodeId: string) => Effect.Effect<EngineDecision$1>;
    readonly eventReceived: (eventName: string, payload: unknown, correlationId?: string | null) => Effect.Effect<EngineDecision$1>;
    readonly signalReceived: (signalName: string, payload: unknown, correlationId?: string | null) => Effect.Effect<EngineDecision$1>;
    readonly timerFired: (nodeId: string, firedAtMs?: number) => Effect.Effect<EngineDecision$1>;
    readonly hotReloaded: (graph: WorkflowGraph) => Effect.Effect<EngineDecision$1>;
    readonly heartbeatTimedOut: (nodeId: string, iteration?: number, details?: Record<string, unknown>) => Effect.Effect<EngineDecision$1>;
    readonly cacheResolved: (output: TaskOutput$1, cached: boolean) => Effect.Effect<EngineDecision$1>;
    readonly cacheMissed: (nodeId: string, iteration?: number) => Effect.Effect<EngineDecision$1>;
    readonly recoverOrphanedTasks: () => Effect.Effect<EngineDecision$1>;
    readonly cancelRequested: () => Effect.Effect<EngineDecision$1>;
    readonly getTaskStates: () => Effect.Effect<TaskStateMap$4>;
    readonly getSchedule: () => Effect.Effect<ScheduleSnapshot$1 | null>;
    readonly getCurrentGraph: () => Effect.Effect<WorkflowGraph | null>;
};

/** A breached Aspects budget for a task that is about to be dispatched. */
type AspectBudgetBreach = {
    readonly kind: "tokens" | "latency";
    readonly limit: number;
    readonly current: number;
    readonly onExceeded: "fail" | "warn" | "skip-remaining";
};
type WorkflowSessionOptions$2 = {
    readonly runId?: string;
    readonly nowMs?: () => number;
    readonly requireStableFinish?: boolean;
    readonly requireRerenderOnOutputChange?: boolean;
    readonly initialRalphState?: ReadonlyMap<string, {
        readonly iteration: number;
        readonly done: boolean;
    }>;
    /**
     * Evaluate a runnable task's Aspects budgets against the run's accumulated
     * usage. Return the first breach, or `null`/`undefined` when within budget.
     * Only invoked for tasks that would otherwise execute.
     */
    readonly evaluateAspectBudget?: (descriptor: TaskDescriptor$4) => AspectBudgetBreach | null | undefined;
    /** Called when a task is skipped because its budget was exceeded (`skip-remaining`). */
    readonly onAspectBudgetSkip?: (descriptor: TaskDescriptor$4, breach: AspectBudgetBreach) => void;
    /** Called when a task continues despite an exceeded budget (`warn`). */
    readonly onAspectBudgetWarn?: (descriptor: TaskDescriptor$4, breach: AspectBudgetBreach) => void;
};

type TaskRecord$1 = {
    readonly descriptor: TaskDescriptor$3;
    readonly state: TaskState$2;
    readonly output?: unknown;
    readonly error?: unknown;
    readonly updatedAtMs: number;
};

type SmithersAlertSeverity$1 = "info" | "warning" | "critical";
type SmithersAlertLabels$1 = Record<string, string>;
type SmithersAlertReactionKind$1 = "emit-only" | "pause" | "cancel" | "open-approval" | "deliver";
type SmithersAlertReaction$1 = {
    kind: "emit-only";
} | {
    kind: "pause";
} | {
    kind: "cancel";
} | {
    kind: "open-approval";
} | {
    kind: "deliver";
    destination: string;
};
type SmithersAlertReactionRef$1 = string | SmithersAlertReaction$1;
type SmithersAlertPolicyDefaults$1 = {
    owner?: string;
    severity?: SmithersAlertSeverity$1;
    runbook?: string;
    labels?: SmithersAlertLabels$1;
};
type SmithersAlertPolicyRule$1 = SmithersAlertPolicyDefaults$1 & {
    afterMs?: number;
    reaction?: SmithersAlertReactionRef$1;
};
type SmithersAlertPolicy$1 = {
    defaults?: SmithersAlertPolicyDefaults$1;
    rules?: Record<string, SmithersAlertPolicyRule$1>;
    reactions?: Record<string, SmithersAlertReaction$1>;
};
type SmithersWorkflowOptions$1 = {
    alertPolicy?: SmithersAlertPolicy$1;
    cache?: boolean;
    workflowHash?: string;
};

type RetryWaitMap$3 = Map<string, number>;

type RetryBackoff$1 = "fixed" | "linear" | "exponential";
type RetryPolicy$3 = {
    backoff?: RetryBackoff$1;
    initialDelayMs?: number;
};

type ReadonlyTaskStateMap$2 = ReadonlyMap<string, TaskState$2>;

type RalphState$1 = {
    readonly iteration: number;
    readonly done: boolean;
};

type RalphStateMap$4 = Map<string, RalphState$1>;

type CachePolicy$1<Ctx = unknown> = {
    by?: (ctx: Ctx) => unknown;
    version?: string;
    key?: string;
    ttlMs?: number;
    scope?: "run" | "workflow" | "global";
    [key: string]: unknown;
};

/**
 * @param {string} nodeId
 * @param {number} iteration
 * @returns {string}
 */
declare function buildStateKey(nodeId: string, iteration: number): string;

/**
 * @param {string} key
 * @returns {{ readonly nodeId: string; readonly iteration: number; }}
 */
declare function parseStateKey(key: string): {
    readonly nodeId: string;
    readonly iteration: number;
};

/** @typedef {import("./ReadonlyTaskStateMap.ts").ReadonlyTaskStateMap} ReadonlyTaskStateMap */
/** @typedef {import("./TaskStateMap.ts").TaskStateMap} TaskStateMap */
/**
 * @param {ReadonlyTaskStateMap} states
 * @returns {TaskStateMap}
 */
declare function cloneTaskStateMap(states: ReadonlyTaskStateMap$1): TaskStateMap$3;
type ReadonlyTaskStateMap$1 = ReadonlyTaskStateMap$2;
type TaskStateMap$3 = TaskStateMap$4;

/** @typedef {import("@smithers-orchestrator/graph").TaskDescriptor} TaskDescriptor */
/** @typedef {import("./TaskState.ts").TaskState} TaskState */
/**
 * @param {TaskState} state
 * @param {Pick<TaskDescriptor, "continueOnFail">} [descriptor]
 * @returns {boolean}
 */
declare function isTerminalState(state: TaskState$1, descriptor?: Pick<TaskDescriptor$2, "continueOnFail">): boolean;
type TaskDescriptor$2 = _smithers_orchestrator_graph.TaskDescriptor;
type TaskState$1 = TaskState$2;

declare class Scheduler extends Context.TagClassShape<"Scheduler", SchedulerService> {
}
type TaskDescriptor$1 = _smithers_orchestrator_graph.TaskDescriptor;
type TaskStateMap$2 = TaskStateMap$4;
type PlanNode$3 = PlanNode$4;
type RalphStateMap$3 = RalphStateMap$4;
type RetryWaitMap$2 = RetryWaitMap$3;
type ScheduleResult$2 = ScheduleResult$3;
type SchedulerService = {
    readonly schedule: (plan: PlanNode$3 | null, states: TaskStateMap$2, descriptors: Map<string, TaskDescriptor$1>, ralphState: RalphStateMap$3, retryWait: RetryWaitMap$2, nowMs: number) => effect.Effect.Effect<ScheduleResult$2>;
};

/** @type {Layer.Layer<Scheduler, never, never>} */
declare const SchedulerLive: Layer.Layer<Scheduler, never, never>;

/**
 * @param {XmlNode | null} xml
 * @param {RalphStateMap} [ralphState]
 * @returns {{ readonly plan: PlanNode | null; readonly ralphs: readonly RalphMeta[]; }}
 */
declare function buildPlanTree(xml: XmlNode | null, ralphState?: RalphStateMap$2): {
    readonly plan: PlanNode$2 | null;
    readonly ralphs: readonly RalphMeta$1[];
};
type PlanNode$2 = PlanNode$4;
type RalphMeta$1 = RalphMeta$2;
type RalphStateMap$2 = RalphStateMap$4;
type XmlNode = _smithers_orchestrator_graph.XmlNode;

/**
 * @param {PlanNode | null} plan
 * @param {TaskStateMap} states
 * @param {Map<string, TaskDescriptor>} descriptors
 * @param {RalphStateMap} ralphState
 * @param {RetryWaitMap} retryWait
 * @param {number} nowMs
 * @returns {ScheduleResult}
 */
declare function scheduleTasks(plan: PlanNode$1 | null, states: TaskStateMap$1, descriptors: Map<string, TaskDescriptor>, ralphState: RalphStateMap$1, retryWait: RetryWaitMap$1, nowMs: number): ScheduleResult$1;
type PlanNode$1 = PlanNode$4;
type RalphStateMap$1 = RalphStateMap$4;
type RetryWaitMap$1 = RetryWaitMap$3;
type ScheduleResult$1 = ScheduleResult$3;
type TaskDescriptor = _smithers_orchestrator_graph.TaskDescriptor;
type TaskStateMap$1 = TaskStateMap$4;

declare class WorkflowSession extends Context.TagClassShape<"WorkflowSession", WorkflowSessionService$2> {
}

/**
 * @param {WorkflowSessionOptions} [options]
 * @returns {WorkflowSessionService}
 */
declare function makeWorkflowSession(options?: WorkflowSessionOptions$1): WorkflowSessionService$1;
type WorkflowSessionOptions$1 = WorkflowSessionOptions$2;
type WorkflowSessionService$1 = WorkflowSessionService$2;

/**
 * WARNING — do not consume this layer as-is. `Layer.sync` builds **one** shared
 * `makeWorkflowSession()` instance for the whole layer scope, but a workflow
 * session carries per-run state, so sharing it across runs is a correctness bug.
 * The engine intentionally bypasses this Tag and constructs a fresh session per
 * run via `makeWorkflowSession()` directly — which is why nothing yields
 * `WorkflowSession` today. Before any consumer reads the Tag, rework this into a
 * per-run/scoped provider (e.g. `Layer.scoped` or a factory service) so each run
 * gets its own session.
 *
 * @type {Layer.Layer<WorkflowSession, never, never>}
 */
declare const WorkflowSessionLive: Layer.Layer<WorkflowSession, never, never>;

/**
 * @returns {number}
 */
declare function nowMs(): number;

/**
 * Convert a RetryPolicy to an Effect Schedule for use with Effect.retry.
 *
 * @param {RetryPolicy} policy
 * @returns {Schedule.Schedule<unknown>}
 */
declare function retryPolicyToSchedule(policy: RetryPolicy$2): Schedule$1.Schedule<unknown>;
type RetryPolicy$2 = RetryPolicy$3;

/**
 * @param {Schedule.Schedule<unknown>} schedule
 * @param {number} attempt
 * @returns {number}
 */
declare function retryScheduleDelayMs(schedule: Schedule.Schedule<unknown>, attempt: number): number;

/** @typedef {import("./RetryPolicy.ts").RetryPolicy} RetryPolicy */
/**
 * @param {RetryPolicy | undefined} policy
 * @param {number} attempt
 * @returns {number}
 */
declare function computeRetryDelayMs(policy: RetryPolicy$1 | undefined, attempt: number): number;
type RetryPolicy$1 = RetryPolicy$3;

type ApprovalResolution = ApprovalResolution$1;
type CachePolicy = CachePolicy$1;
type ContinuationRequest = ContinuationRequest$1;
type ContinueAsNewTransition = ContinueAsNewTransition$1;
type EngineDecision = EngineDecision$1;
type PlanNode = PlanNode$4;
type RalphMeta = RalphMeta$2;
type RalphState = RalphState$1;
type RalphStateMap = RalphStateMap$4;
type ReadonlyTaskStateMap = ReadonlyTaskStateMap$2;
type RenderContext = RenderContext$1;
type RetryBackoff = RetryBackoff$1;
type RetryPolicy = RetryPolicy$3;
type RetryWaitMap = RetryWaitMap$3;
type RunResult = RunResult$1;
type ScheduleResult = ScheduleResult$3;
type ScheduleSnapshot = ScheduleSnapshot$1;
type SmithersAlertLabels = SmithersAlertLabels$1;
type SmithersAlertPolicy = SmithersAlertPolicy$1;
type SmithersAlertPolicyDefaults = SmithersAlertPolicyDefaults$1;
type SmithersAlertPolicyRule = SmithersAlertPolicyRule$1;
type SmithersAlertReaction = SmithersAlertReaction$1;
type SmithersAlertReactionKind = SmithersAlertReactionKind$1;
type SmithersAlertReactionRef = SmithersAlertReactionRef$1;
type SmithersAlertSeverity = SmithersAlertSeverity$1;
type SmithersWorkflowOptions = SmithersWorkflowOptions$1;
type TaskFailure = TaskFailure$1;
type TaskOutput = TaskOutput$1;
type TaskRecord = TaskRecord$1;
type TaskState = TaskState$2;
type TaskStateMap = TaskStateMap$4;
type TokenUsage = TokenUsage$1;
type WaitReason = WaitReason$1;
type WorkflowSessionOptions = WorkflowSessionOptions$2;
type WorkflowSessionService = WorkflowSessionService$2;

export { type ApprovalResolution, type CachePolicy, type ContinuationRequest, type ContinueAsNewTransition, type EngineDecision, type PlanNode, type RalphMeta, type RalphState, type RalphStateMap, type ReadonlyTaskStateMap, type RenderContext, type RetryBackoff, type RetryPolicy, type RetryWaitMap, type RunResult, type ScheduleResult, type ScheduleSnapshot, Scheduler, SchedulerLive, type SmithersAlertLabels, type SmithersAlertPolicy, type SmithersAlertPolicyDefaults, type SmithersAlertPolicyRule, type SmithersAlertReaction, type SmithersAlertReactionKind, type SmithersAlertReactionRef, type SmithersAlertSeverity, type SmithersWorkflowOptions, type TaskFailure, type TaskOutput, type TaskRecord, type TaskState, type TaskStateMap, type TokenUsage, type WaitReason, WorkflowSession, WorkflowSessionLive, type WorkflowSessionOptions, type WorkflowSessionService, buildPlanTree, buildStateKey, cloneTaskStateMap, computeRetryDelayMs, isTerminalState, makeWorkflowSession, nowMs, parseStateKey, retryPolicyToSchedule, retryScheduleDelayMs, scheduleTasks };
