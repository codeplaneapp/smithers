import * as effect from 'effect';
import { Context, Layer, Effect, Schedule } from 'effect';
import * as _smthrs_graph from '@smthrs/graph';
import { TaskDescriptor as TaskDescriptor$4, WorkflowGraph } from '@smthrs/graph';
import { TaskDescriptor as TaskDescriptor$5 } from '@smthrs/graph/TaskDescriptor';

type TaskState$2 = "pending" | "waiting-approval" | "waiting-event" | "waiting-timer" | "waiting-quota" | "waiting-bound" | "bound-stale" | "in-progress" | "finished" | "failed" | "stalled" | "cancelled" | "skipped";

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
    /** Error codes that arm the catch block; absent means catch everything. */
    readonly catchErrors?: readonly string[];
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
    readonly runnable: readonly TaskDescriptor$4[];
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
    readonly taskFailures?: unknown;
    readonly ralphIterations?: ReadonlyMap<string, number>;
    readonly trigger?: RenderTrigger;
};

type RunResult$1 = {
    readonly runId: string;
    readonly status: "running" | "finished" | "failed" | "cancelled" | "continued" | "waiting-approval" | "waiting-event" | "waiting-timer" | "waiting-quota";
    readonly output?: unknown;
    readonly error?: unknown;
    readonly nextRunId?: string;
    /**
     * Number of tasks that ended in a `failed` state yet did not fail the run —
     * "masked" child failures the run-level status cannot express. Present (and
     * `> 0`) only on a `finished` result that tolerated at least one failure
     * (a {@link https://smithers.sh/components/task `continueOnFail`} task, or an
     * agent task that failed transiently: rate limit, timeout, abort). A binary
     * `finished` status would otherwise read as a clean success. Persisted
     * finished runs with this signal derive as `succeeded-with-failures`, while
     * retaining the compatible terminal lifecycle status `finished`. See
     * `docs/runtime/run-state.mdx`.
     */
    readonly failedChildren?: number;
    /**
     * Task state keys (`nodeId::iteration`) of the tasks counted by
     * {@link failedChildren}. The iteration disambiguates the same `nodeId` failing
     * across loop/Ralph iterations.
     */
    readonly failedChildKeys?: readonly string[];
    /**
     * Loops (`<Loop>`/`<ReviewLoop>`) that exited via `onMaxReached: "return-last"`
     * with their `until` predicate still false. Present (and non-empty) only on a
     * `finished` result: the run completed, but these loops never converged, so a
     * green `done` verdict would be a lie (#1464 AWF-1).
     */
    readonly exhaustedLoops?: readonly {
        readonly id: string;
        readonly iteration: number;
        readonly maxIterations: number | null;
    }[];
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
    readonly _tag: "Bound";
    readonly nodeId: string;
    readonly code: "BOUND_STALE" | "BOUND_MISSING";
    readonly bindings?: ReadonlyArray<{
        readonly table: string;
        readonly nodeId: string;
        readonly iteration: number;
        readonly digest: string;
    }>;
} | {
    readonly _tag: "Quota";
    readonly quotaBlockedCount: number;
    readonly resetAtMs?: number;
    /**
     * The quota-blocked tasks (capped sample): which node hit which
     * provider limit, so operators see WHO is waiting, not just a count.
     */
    readonly blocked?: ReadonlyArray<{
        readonly nodeId: string;
        readonly resetAtMs?: number;
        readonly message?: string;
    }>;
};

type EngineDecision$1 = {
    readonly _tag: "Execute";
    readonly tasks: readonly TaskDescriptor$4[];
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
    readonly initialTimerStarts?: ReadonlyMap<string, number>;
    /** Retry-policy failure rungs restored from durable attempts. */
    readonly initialRetryCounts?: ReadonlyMap<string, number>;
    /** Absolute retry deadlines restored from durable attempts. */
    readonly initialRetryWait?: ReadonlyMap<string, number>;
    /** Last durable failures restored for tasks that may already be exhausted. */
    readonly initialTaskFailures?: ReadonlyMap<string, {
        readonly error: unknown;
        readonly recoveryCommand?: string;
    }>;
    /** Approval task keys restored from durable approved rows. */
    readonly initialApprovals?: ReadonlySet<string>;
    /**
     * Evaluate a runnable task's Aspects budgets against the run's accumulated
     * usage. Return the first breach, or `null`/`undefined` when within budget.
     * Only invoked for tasks that would otherwise execute.
     */
    readonly evaluateAspectBudget?: (descriptor: TaskDescriptor$5) => AspectBudgetBreach | null | undefined;
    /** Called when a task is skipped because its budget was exceeded (`skip-remaining`). */
    readonly onAspectBudgetSkip?: (descriptor: TaskDescriptor$5, breach: AspectBudgetBreach) => void;
    /** Called when a task continues despite an exceeded budget (`warn`). */
    readonly onAspectBudgetWarn?: (descriptor: TaskDescriptor$5, breach: AspectBudgetBreach) => void;
};

type TaskRecord$1 = {
    readonly descriptor: TaskDescriptor$4;
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
/**
 * Where a workflow's `RunResult.output` rows are read from. Mirrors the
 * component-level `OutputTarget` union (see `@smthrs/components`
 * `OutputTarget`), restated locally because `@smthrs/scheduler`
 * is a pure decision engine that must not depend on zod or components:
 *
 * - a Zod schema object registered via `createSmithers(...).outputs.<key>` (recommended),
 * - a Drizzle table object, or
 * - a string schema key (escape hatch).
 */
type SmithersWorkflowOutputTarget = {
    readonly _def: unknown;
} | {
    readonly $inferSelect: Record<string, unknown>;
} | string;
type SmithersWorkflowOptions$1 = {
    alertPolicy?: SmithersAlertPolicy$1;
    cache?: boolean;
    /**
     * Environment visible while the CLI renders and executes this workflow.
     * Module top-level evaluation occurs before this declaration can be read.
     * Ambient variables are inherited by default. `inherit: false` starts empty;
     * `allow` then copies exact names or `PREFIX*` matches, `deny` removes exact
     * names or prefix matches, and `set` is applied last.
     */
    environment?: {
        inherit?: boolean;
        allow?: string[];
        deny?: string[];
        set?: Record<string, string>;
    };
    /**
     * Per-workflow opt-out for the default-on post-failure autopsy. When `false`,
     * a failure of this workflow never auto-launches the `post-failure` autopsy.
     * Use it for workflows that fail deliberately (e.g. fault-injection e2e
     * suites) so they don't burn agent tokens autopsying an expected failure.
     * Defaults to on. The CLI's `--no-post-failure` flag and `SMITHERS_POST_FAILURE=0`
     * env var remain independent, broader opt-outs.
     */
    postFailureAutopsy?: boolean;
    /**
     * Explicit workflow-level output schema/table used to populate
     * `RunResult.output` (and therefore a parent `Subflow`'s child result). Pass
     * a `createSmithers(...).outputs.<key>` schema, a Drizzle table, or a string
     * schema key. Defaults to the child schema key literally named `output`.
     */
    output?: SmithersWorkflowOutputTarget;
    workflowHash?: string;
};

type RetryWaitMap$3 = Map<string, number>;

type RetryBackoff$1 = "fixed" | "linear" | "exponential";
/**
 * Author-facing retry gate (#1500). Return `false` (or set the flag itself to
 * `false`) to make a failure terminal immediately: no retry is scheduled and
 * the task goes to its terminal state with the full error payload.
 */
type RetryPredicate = (error: unknown) => boolean;
type RetryPolicy$4 = {
    backoff?: RetryBackoff$1;
    initialDelayMs?: number;
    /**
     * Non-progress detection: after this many consecutive attempts fail with an
     * identical error signature, the task is marked `stalled` (a distinct
     * terminal state) instead of being retried again. Defaults to 3; set to 0
     * to disable stall detection for the task.
     */
    maxIdenticalFailures?: number;
    /**
     * Classify a failure before any retry is scheduled. `false` marks every
     * failure of the task terminal (equivalent to `retries={0}` but expressed
     * on the policy); a function is consulted per failure and a `false` return
     * makes that failure terminal.
     */
    retryable?: boolean | RetryPredicate;
};

type ReadonlyTaskStateMap$2 = ReadonlyMap<string, TaskState$2>;

type RalphState$1 = {
    readonly iteration: number;
    readonly done: boolean;
    /**
     * True when the loop reached `maxIterations` under `onMaxReached: "return-last"`
     * with its `until` predicate still false. A `done` loop with `exhausted` set did
     * not converge — the run must not read as a clean success (#1464 AWF-1).
     */
    readonly exhausted?: boolean;
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

/** @typedef {import("@smthrs/graph").TaskDescriptor} TaskDescriptor */
/** @typedef {import("./TaskState.ts").TaskState} TaskState */
/**
 * @param {TaskState} state
 * @param {Pick<TaskDescriptor, "continueOnFail">} [descriptor]
 * @returns {boolean}
 */
declare function isTerminalState(state: TaskState$1, descriptor?: Pick<TaskDescriptor$3, "continueOnFail">): boolean;
type TaskDescriptor$3 = _smthrs_graph.TaskDescriptor;
type TaskState$1 = TaskState$2;

declare class Scheduler extends Context.ServiceClass.Shape<"Scheduler", SchedulerService> {
}
type TaskDescriptor$2 = _smthrs_graph.TaskDescriptor;
type TaskStateMap$2 = TaskStateMap$4;
type PlanNode$3 = PlanNode$4;
type RalphStateMap$3 = RalphStateMap$4;
type RetryWaitMap$2 = RetryWaitMap$3;
type ScheduleResult$2 = ScheduleResult$3;
type SchedulerService = {
    readonly schedule: (plan: PlanNode$3 | null, states: TaskStateMap$2, descriptors: Map<string, TaskDescriptor$2>, ralphState: RalphStateMap$3, retryWait: RetryWaitMap$2, nowMs: number, taskFailures?: ReadonlyMap<string, unknown>) => effect.Effect.Effect<ScheduleResult$2>;
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
type XmlNode = _smthrs_graph.XmlNode;

/**
 * @param {PlanNode | null} plan
 * @param {TaskStateMap} states
 * @param {Map<string, TaskDescriptor>} descriptors
 * @param {RalphStateMap} ralphState
 * @param {RetryWaitMap} retryWait
 * @param {number} nowMs
 * @param {ReadonlyMap<string, unknown>} [taskFailures] recorded failure payloads
 *   keyed by task state key; consulted by the <TryCatchFinally catchErrors>
 *   gate to match failed try tasks against the filtered error codes
 * @param {ReadonlySet<string>} [approvedTaskKeys] approval task keys restored
 *   from durable decisions; these keep their subtree admission across resume
 * @returns {ScheduleResult}
 */
declare function scheduleTasks(plan: PlanNode$1 | null, states: TaskStateMap$1, descriptors: Map<string, TaskDescriptor$1>, ralphState: RalphStateMap$1, retryWait: RetryWaitMap$1, nowMs: number, taskFailures?: ReadonlyMap<string, unknown>, approvedTaskKeys?: ReadonlySet<string>): ScheduleResult$1;
type PlanNode$1 = PlanNode$4;
type RalphStateMap$1 = RalphStateMap$4;
type RetryWaitMap$1 = RetryWaitMap$3;
type ScheduleResult$1 = ScheduleResult$3;
type TaskDescriptor$1 = _smthrs_graph.TaskDescriptor;
type TaskStateMap$1 = TaskStateMap$4;

declare class WorkflowSession extends Context.ServiceClass.Shape<"WorkflowSession", WorkflowSessionService$2> {
}

/**
 * WARNING: Do not consume this layer as-is. `Layer.sync` builds **one** shared
 * `makeWorkflowSession()` instance for the whole layer scope, but a workflow
 * session carries per-run state, so sharing it across runs is a correctness bug.
 * The engine intentionally bypasses this Tag and constructs a fresh session per
 * run via `makeWorkflowSession()` directly. This is why nothing yields
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
 * @returns {Schedule.Schedule<unknown, unknown>}
 */
declare function retryPolicyToSchedule(policy: RetryPolicy$3): Schedule.Schedule<unknown, unknown>;
type RetryPolicy$3 = RetryPolicy$4;

/**
 * @param {import("effect").Schedule.Schedule<unknown, unknown>} schedule
 * @param {number} attempt
 * @returns {number}
 */
declare function retryScheduleDelayMs(schedule: effect.Schedule.Schedule<unknown, unknown>, attempt: number): number;

/** @typedef {import("./RetryPolicy.ts").RetryPolicy} RetryPolicy */
/**
 * @param {RetryPolicy | undefined} policy
 * @param {number} attempt
 * @returns {number}
 */
declare function computeRetryDelayMs(policy: RetryPolicy$2 | undefined, attempt: number): number;
type RetryPolicy$2 = RetryPolicy$4;

/**
 * Failure shapes that retrying can never fix, independent of the task kind
 * (#1500). Classified BEFORE a retry is scheduled so a deterministic failure
 * goes straight to the terminal state with its full payload instead of
 * burning the retry budget.
 *
 * - `ENOENT` messages: a missing filesystem precondition. Re-running `statx`
 *   on a path that does not exist cannot succeed on a later attempt.
 * - `*_TOO_LARGE` codes: hard size-cap breaches (heartbeat payloads, tool
 *   files/contents/patches, sandbox bundles, continuation state). Regenerating
 *   the same artifact reproduces the same breach.
 *
 * Schema-validation failures (`INVALID_OUTPUT`) are deliberately NOT here:
 * agent tasks get a fresh generation on each attempt, so only compute tasks
 * treat them as terminal (see NON_RETRYABLE_COMPUTE_CODES in
 * makeWorkflowSession). An agent task that cannot satisfy its validator is
 * caught by stall detection once the failures repeat byte-identically.
 * @param {unknown} error
 * @returns {boolean}
 */
declare function isTerminalFailureShape(error: unknown): boolean;

/**
 * Whether a failure may consume retry budget. Exported so the engine can
 * mirror the scheduler's retry/terminal verdict when it persists attempt
 * rows and node states (#1500): both sides must agree or a resumed run
 * would re-classify the same failure differently.
 * @param {TaskDescriptor} descriptor
 * @param {unknown} error
 * @returns {boolean}
 */
declare function isRetryableFailure(descriptor: TaskDescriptor, error: unknown): boolean;
/**
 * Whether a failure may consume the non-progress budget (#1500). Stall
 * detection only applies to failures the task could plausibly keep retrying:
 * a failure the scheduler will not retry at all is already terminal, and a
 * transient agent-session failure is explicitly exempted from failing the run
 * (see unhandledFailureDecision), so stalling on one would park the node in a
 * terminal state the run never acts on.
 *
 * Exported so the engine reaches the same verdict when it persists the node
 * row: both sides must agree or a resumed run would re-classify the same
 * failure differently.
 * @param {TaskDescriptor} descriptor
 * @param {unknown} error
 * @returns {boolean}
 */
declare function isStallableFailure(descriptor: TaskDescriptor, error: unknown): boolean;
/**
 * Mutable per-run session state, owned exclusively by makeWorkflowSession.
 * All maps/sets are keyed by the canonical task state key (`nodeId::iteration`)
 * unless noted otherwise.
 * @typedef {object} SessionState
 * @property {string} runId
 * @property {WorkflowGraph | null} graph
 * @property {PlanNode | null} plan
 * @property {Map<string, TaskDescriptor>} descriptors keyed by nodeId
 * @property {TaskStateMap} states
 * @property {Map<string, TaskOutput>} outputs
 * @property {Map<string, unknown>} failures
 * @property {Map<string, { readonly error: unknown, readonly recoveryCommand?: string }>} restoredTaskFailures
 * @property {Map<string, TaskDescriptor>} failureDescriptors
 * @property {Map<string, number>} retryCounts
 * @property {Map<string, { signature: string, streak: number }>} errorStreaks state key → latest error signature and its consecutive-failure count (#1500)
 * @property {RetryWaitMap} retryWait state key → earliest retry time (ms)
 * @property {Set<string>} approvals
 * @property {RalphStateMap} ralphState keyed by ralph loop id
 * @property {Map<string, number>} quotaResetTimes state key → quota reset timestamp (ms)
 * @property {Map<string, number>} timerStarts state key → duration-timer start (ms), the anchor its deadline is computed from
 * @property {ScheduleSnapshot | null} schedule
 * @property {boolean} cancelled
 * @property {string | null} lastMountedSignature
 * @property {string | null} lastDeadlockSignature
 */
/**
 * @param {WorkflowSessionOptions} [options]
 * @returns {WorkflowSessionService}
 */
declare function makeWorkflowSession(options?: WorkflowSessionOptions$1): WorkflowSessionService$1;
type TaskDescriptor = _smthrs_graph.TaskDescriptor;
type WorkflowSessionOptions$1 = WorkflowSessionOptions$2;
type WorkflowSessionService$1 = WorkflowSessionService$2;

/**
 * Add a validated relative delay without rounding the resulting deadline
 * below the declared minimum. Very large safe-integer delays can produce an
 * unsafe-integer absolute timestamp; advance by one representable step when
 * floating-point addition rounded down.
 *
 * @param {number} startedAtMs
 * @param {number} delayMs
 */
declare function retryDeadlineMs(startedAtMs: number, delayMs: number): number;
/**
 * @param {{ failureCount: number; failedAtMs: number; retryAfterMs: number; retryPolicy?: RetryPolicy }} input
 */
declare function createDurableRetryState(input: {
    failureCount: number;
    failedAtMs: number;
    retryAfterMs: number;
    retryPolicy?: RetryPolicy$1;
}): {
    version: number;
    failureCount: number;
    retryAtMs: number;
};
/**
 * Validate the deliberately small attempt-meta wire value. Returning null is
 * useful both for old rows (which have no value) and for callers that need to
 * distinguish malformed new rows with an own-property check.
 *
 * @param {unknown} value
 * @returns {{ version: 1; failureCount: number; retryAtMs: number } | null}
 */
declare function parseDurableRetryState(value: unknown): {
    version: 1;
    failureCount: number;
    retryAtMs: number;
} | null;
/**
 * Carry the already-persisted retry decision from the engine's failed attempt
 * row to the in-memory scheduler without putting an internal field on the
 * public/provider error payload.
 *
 * @param {unknown} error
 * @param {unknown} state
 * @returns {unknown}
 */
declare function attachDurableRetryState(error: unknown, state: unknown): unknown;
/**
 * @param {unknown} error
 * @returns {{ version: 1; failureCount: number; retryAtMs: number } | null}
 */
declare function durableRetryStateFromError(error: unknown): {
    version: 1;
    failureCount: number;
    retryAtMs: number;
} | null;
type RetryPolicy$1 = RetryPolicy$4;

/**
 * Normalize the volatile parts of an error message so two failures that are
 * "the same failure" produce the same signature: absolute paths (run/tmp
 * dirs), UUIDs and long hex ids, and bare numbers (byte counts, ports,
 * sizes) are each replaced with a fixed placeholder. The transform is
 * deliberately simple and deterministic: it never looks at the environment,
 * only at the string.
 * @param {string} message
 * @returns {string}
 */
declare function normalizeErrorMessage(message: string): string;
/**
 * Compute a stable signature for a failure payload. Two attempts of the same
 * node that fail for the same reason produce the same signature even when
 * run ids, temp paths, or byte counts differ.
 * @param {unknown} error
 * @returns {string}
 */
declare function computeErrorSignature(error: unknown): string;
/**
 * Resolve the stall threshold for a retry policy: how many consecutive
 * identical failures mark the task `stalled`. Defaults to
 * DEFAULT_MAX_IDENTICAL_FAILURES; a value <= 0 (or Infinity) disables stall
 * detection for the task.
 * @param {{ maxIdenticalFailures?: number } | undefined} retryPolicy
 * @returns {number}
 */
declare function resolveMaxIdenticalFailures(retryPolicy: {
    maxIdenticalFailures?: number;
} | undefined): number;
/**
 * Read the identical-failure streak the engine stamped onto a failure
 * payload's details before persisting the attempt. The stamp lets stall
 * detection survive a run resume: the streak is recomputed from durable
 * attempt rows on every failure, so the in-memory session does not need its
 * own history.
 * @param {unknown} error
 * @returns {number | undefined}
 */
declare function readIdenticalFailureStreak(error: unknown): number | undefined;
/**
 * Default number of consecutive failures with an identical error signature
 * after which a task is marked `stalled` instead of being retried again
 * (#1500). Override per task with `retryPolicy.maxIdenticalFailures`.
 */
declare const DEFAULT_MAX_IDENTICAL_FAILURES: 3;

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
type RetryPolicy = RetryPolicy$4;
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

export { type ApprovalResolution, type CachePolicy, type ContinuationRequest, type ContinueAsNewTransition, DEFAULT_MAX_IDENTICAL_FAILURES, type EngineDecision, type PlanNode, type RalphMeta, type RalphState, type RalphStateMap, type ReadonlyTaskStateMap, type RenderContext, type RetryBackoff, type RetryPolicy, type RetryWaitMap, type RunResult, type ScheduleResult, type ScheduleSnapshot, Scheduler, SchedulerLive, type SmithersAlertLabels, type SmithersAlertPolicy, type SmithersAlertPolicyDefaults, type SmithersAlertPolicyRule, type SmithersAlertReaction, type SmithersAlertReactionKind, type SmithersAlertReactionRef, type SmithersAlertSeverity, type SmithersWorkflowOptions, type TaskFailure, type TaskOutput, type TaskRecord, type TaskState, type TaskStateMap, type TokenUsage, type WaitReason, WorkflowSession, WorkflowSessionLive, type WorkflowSessionOptions, type WorkflowSessionService, attachDurableRetryState, buildPlanTree, buildStateKey, cloneTaskStateMap, computeErrorSignature, computeRetryDelayMs, createDurableRetryState, durableRetryStateFromError, isRetryableFailure, isStallableFailure, isTerminalFailureShape, isTerminalState, makeWorkflowSession, normalizeErrorMessage, nowMs, parseDurableRetryState, parseStateKey, readIdenticalFailureStreak, resolveMaxIdenticalFailures, retryDeadlineMs, retryPolicyToSchedule, retryScheduleDelayMs, scheduleTasks };
