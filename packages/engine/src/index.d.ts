import * as _smithers_orchestrator_components_SmithersWorkflow from '@smithers-orchestrator/components/SmithersWorkflow';
import { SmithersWorkflow as SmithersWorkflow$2 } from '@smithers-orchestrator/components/SmithersWorkflow';
import * as _smithers_orchestrator_scheduler_SmithersWorkflowOptions from '@smithers-orchestrator/scheduler/SmithersWorkflowOptions';
import * as effect from 'effect';
import { Schema, Effect, Layer, Context, Exit, Scope } from 'effect';
import * as _smithers_orchestrator_errors_SmithersError from '@smithers-orchestrator/errors/SmithersError';
import { SmithersError } from '@smithers-orchestrator/errors/SmithersError';
import * as _smithers_orchestrator_driver_RunResult from '@smithers-orchestrator/driver/RunResult';
import * as _smithers_orchestrator_observability_SmithersEvent from '@smithers-orchestrator/observability/SmithersEvent';
import * as _smithers_orchestrator_observability_correlation from '@smithers-orchestrator/observability/correlation';
import { EventEmitter } from 'node:events';
import * as _smithers_orchestrator_graph_XmlNode from '@smithers-orchestrator/graph/XmlNode';
import * as _smithers_orchestrator_graph_TaskDescriptor from '@smithers-orchestrator/graph/TaskDescriptor';
import { TaskDescriptor } from '@smithers-orchestrator/graph/TaskDescriptor';
import * as _smithers_orchestrator_scheduler from '@smithers-orchestrator/scheduler';
export { Scheduler, SchedulerLive, buildStateKey, cloneTaskStateMap, isTerminalState, parseStateKey } from '@smithers-orchestrator/scheduler';
import * as drizzle_orm_sqlite_core from 'drizzle-orm/sqlite-core';
import { SQLiteTable as SQLiteTable$1 } from 'drizzle-orm/sqlite-core';
import * as drizzle_orm_bun_sqlite from 'drizzle-orm/bun-sqlite';
import { BunSQLiteDatabase as BunSQLiteDatabase$2 } from 'drizzle-orm/bun-sqlite';
import * as _smithers_orchestrator_db_adapter from '@smithers-orchestrator/db/adapter';
import { SmithersDb as SmithersDb$1 } from '@smithers-orchestrator/db/adapter';
import * as Activity from '@effect/workflow/Activity';
import { TaskAborted } from '@smithers-orchestrator/errors/TaskAborted';
import * as _smithers_orchestrator_scheduler_CachePolicy from '@smithers-orchestrator/scheduler/CachePolicy';
import { CachePolicy } from '@smithers-orchestrator/scheduler/CachePolicy';
import * as _smithers_orchestrator_scheduler_RetryPolicy from '@smithers-orchestrator/scheduler/RetryPolicy';
import { RetryPolicy as RetryPolicy$1 } from '@smithers-orchestrator/scheduler/RetryPolicy';
import * as _smithers_orchestrator_driver_RunOptions from '@smithers-orchestrator/driver/RunOptions';
import * as _smithers_orchestrator_graph_GraphSnapshot from '@smithers-orchestrator/graph/GraphSnapshot';
import { SmithersCtx } from '@smithers-orchestrator/driver/SmithersCtx';
import { Database } from 'bun:sqlite';
import React from 'react';
import * as Rpc from '@effect/rpc/Rpc';
import * as RpcGroup from '@effect/rpc/RpcGroup';
import * as zod from 'zod';
import { z } from 'zod';
import * as _smithers_orchestrator_errors_toSmithersError from '@smithers-orchestrator/errors/toSmithersError';
export { SqlMessageStorage, ensureSqlMessageStorage, ensureSqlMessageStorageEffect, getSqlMessageStorage } from '@smithers-orchestrator/db/sql-message-storage';
import * as Entity from '@effect/cluster/Entity';
import * as DurableDeferred from '@effect/workflow/DurableDeferred';
import * as WorkflowEngine from '@effect/workflow/WorkflowEngine';

type ChildWorkflowDefinition$2 = SmithersWorkflow$2<unknown> | (() => SmithersWorkflow$2<unknown> | unknown);

type AlertHumanRequestOptions$1 = {
    runId: string;
    nodeId: string;
    iteration: number;
    kind: "ask" | "confirm" | "select" | "json";
    prompt: string;
    linkedAlertId?: string;
};

type AlertRuntimeServices$1 = {
    runId: string;
    adapter: unknown;
    eventBus: unknown;
    requestCancel: () => void;
    createHumanRequest: (options: AlertHumanRequestOptions$1) => Promise<void>;
    pauseScheduler: (reason: string) => void;
};

/** @typedef {import("./AlertHumanRequestOptions.ts").AlertHumanRequestOptions} AlertHumanRequestOptions */
/** @typedef {import("./AlertRuntimeServices.ts").AlertRuntimeServices} AlertRuntimeServices */
/** @typedef {import("@smithers-orchestrator/scheduler/SmithersWorkflowOptions").SmithersAlertPolicy} SmithersAlertPolicy */
declare class AlertRuntime {
    /**
   * @param {SmithersAlertPolicy} policy
   * @param {AlertRuntimeServices} services
   */
    constructor(policy: SmithersAlertPolicy, services: AlertRuntimeServices);
    /** @type {SmithersAlertPolicy} */
    policy: SmithersAlertPolicy;
    /** @type {AlertRuntimeServices} */
    services: AlertRuntimeServices;
    start(): void;
    stop(): void;
}
type AlertHumanRequestOptions = AlertHumanRequestOptions$1;
type AlertRuntimeServices = AlertRuntimeServices$1;
type SmithersAlertPolicy = _smithers_orchestrator_scheduler_SmithersWorkflowOptions.SmithersAlertPolicy;

/**
 * @param {SmithersDb} adapter
 * @param {string} runId
 * @param {string} nodeId
 * @param {number} iteration
 * @param {string} [note]
 * @param {string} [decidedBy]
 * @param {unknown} [decision]
 * @param {boolean} [autoApproved]
 * @returns {Effect.Effect<void, SmithersError, never>}
 */
declare function approveNode(adapter: SmithersDb, runId: string, nodeId: string, iteration: number, note?: string, decidedBy?: string, decision?: unknown, autoApproved?: boolean): Effect.Effect<void, SmithersError, never>;
/**
 * @param {SmithersDb} adapter
 * @param {string} runId
 * @param {string} nodeId
 * @param {number} iteration
 * @param {string} [note]
 * @param {string} [decidedBy]
 * @param {unknown} [decision]
 * @returns {Effect.Effect<void, SmithersError, never>}
 */
declare function denyNode(adapter: SmithersDb, runId: string, nodeId: string, iteration: number, note?: string, decidedBy?: string, decision?: unknown): Effect.Effect<void, SmithersError, never>;
declare namespace __approvalInternals {
    export { isAsyncApprovalRequest };
    export { nextRunStatusForApproval };
    export { serializeDecision };
    export { validateNodeWaitingForApproval };
}

/**
 * @param {string | null} [requestJson]
 */
declare function isAsyncApprovalRequest(requestJson?: string | null): boolean;
/**
 * @param {string | null | undefined} currentStatus
 * @param {number} pendingApprovals
 * @returns {"waiting-approval" | "waiting-event" | null}
 */
declare function nextRunStatusForApproval(currentStatus: string | null | undefined, pendingApprovals: number): "waiting-approval" | "waiting-event" | null;
/**
 * @param {unknown} decision
 */
declare function serializeDecision(decision: unknown): string | null;
/**
 * @param {string} runId
 * @param {string} nodeId
 * @param {number} iteration
 * @param {string | null | undefined} state
 * @returns {Effect.Effect<void, SmithersError>}
 */
declare function validateNodeWaitingForApproval(runId: string, nodeId: string, iteration: number, state: string | null | undefined): Effect.Effect<void, SmithersError>;

type ChildWorkflowExecuteOptions$1 = {
    workflow: ChildWorkflowDefinition$2;
    input?: unknown;
    runId?: string;
    parentRunId?: string;
    rootDir?: string;
    allowNetwork?: boolean;
    maxOutputBytes?: number;
    toolTimeoutMs?: number;
    workflowPath?: string;
    signal?: AbortSignal;
};

/**
 * @param {import("@smithers-orchestrator/components/SmithersWorkflow").SmithersWorkflow<any> | undefined} parentWorkflow
 * @param {ChildWorkflowExecuteOptions} options
 * @returns {Promise<{ runId: string; status: RunResult["status"]; output: unknown; }>}
 */
declare function executeChildWorkflow(parentWorkflow: _smithers_orchestrator_components_SmithersWorkflow.SmithersWorkflow<any> | undefined, options: ChildWorkflowExecuteOptions): Promise<{
    runId: string;
    status: RunResult$2["status"];
    output: unknown;
}>;
declare namespace __childWorkflowInternals {
    export { buildChildWorkflowRunId };
    export { normalizeChildInput };
    export { normalizeChildOutput };
    export { resolveChildWorkflow };
    export { stripSystemColumns };
}
type ChildWorkflowDefinition$1 = ChildWorkflowDefinition$2;
type ChildWorkflowExecuteOptions = ChildWorkflowExecuteOptions$1;
type RunResult$2 = _smithers_orchestrator_driver_RunResult.RunResult;
/**
 * @param {string} parentRunId
 * @param {string} stepId
 * @param {number} iteration
 * @returns {string}
 */
declare function buildChildWorkflowRunId(parentRunId: string, stepId: string, iteration: number): string;
/**
 * @param {unknown} input
 * @returns {Record<string, unknown>}
 */
declare function normalizeChildInput(input: unknown): Record<string, unknown>;
/**
 * @param {RunResult} runResult
 * @returns {unknown}
 */
declare function normalizeChildOutput(runResult: RunResult$2): unknown;
/**
 * @param {ChildWorkflowDefinition} definition
 * @param {import("@smithers-orchestrator/components/SmithersWorkflow").SmithersWorkflow<any>} [parentWorkflow]
 * @returns {import("@smithers-orchestrator/components/SmithersWorkflow").SmithersWorkflow<any>}
 */
declare function resolveChildWorkflow(definition: ChildWorkflowDefinition$1, parentWorkflow?: _smithers_orchestrator_components_SmithersWorkflow.SmithersWorkflow<any>): _smithers_orchestrator_components_SmithersWorkflow.SmithersWorkflow<any>;
/**
 * @param {unknown} value
 * @returns {unknown}
 */
declare function stripSystemColumns(value: unknown): unknown;

/** @typedef {import("@smithers-orchestrator/observability/correlation").CorrelationContext} CorrelationContext */
/**
 * @typedef {SmithersEvent & { correlation?: CorrelationContext; }} CorrelatedSmithersEvent
 */
/** @typedef {import("@smithers-orchestrator/observability/SmithersEvent").SmithersEvent} SmithersEvent */
/** @typedef {import("drizzle-orm/bun-sqlite").BunSQLiteDatabase<Record<string, unknown>>} _BunSQLiteDatabase */
declare class EventBus$1 extends EventEmitter<any> {
    /**
   * @param {{ db?: BunSQLiteDatabase; logDir?: string; startSeq?: number }} opts
   */
    constructor(opts: {
        db?: BunSQLiteDatabase;
        logDir?: string;
        startSeq?: number;
    });
    seq: number;
    logDir: string | undefined;
    db: any;
    persistTail: Promise<void>;
    persistError: null;
    /**
   * @param {SmithersEvent} event
   * @returns {Effect.Effect<void, unknown>}
   */
    emitEvent(event: SmithersEvent): Effect.Effect<void, unknown>;
    /**
   * @param {SmithersEvent} event
   * @returns {Effect.Effect<void, unknown>}
   */
    emitEventWithPersist(event: SmithersEvent): Effect.Effect<void, unknown>;
    /**
   * @param {SmithersEvent} event
   * @returns {Promise<void>}
   */
    emitEventQueued(event: SmithersEvent): Promise<void>;
    /**
   * @returns {Effect.Effect<void, unknown>}
   */
    flush(): Effect.Effect<void, unknown>;
    /**
   * @param {CorrelatedSmithersEvent} event
   * @returns {Effect.Effect<void, unknown>}
   */
    persist(event: CorrelatedSmithersEvent): Effect.Effect<void, unknown>;
    /**
   * @param {CorrelatedSmithersEvent} event
   * @returns {Effect.Effect<void, unknown>}
   */
    emitAndTrack(event: CorrelatedSmithersEvent): Effect.Effect<void, unknown>;
    /**
   * @param {CorrelatedSmithersEvent} event
   * @returns {Effect.Effect<void, unknown>}
   */
    enqueuePersist(event: CorrelatedSmithersEvent): Effect.Effect<void, unknown>;
    /**
   * @param {CorrelatedSmithersEvent} event
   * @returns {Effect.Effect<void, unknown>}
   */
    persistDb(event: CorrelatedSmithersEvent): Effect.Effect<void, unknown>;
    /**
   * @param {string} label
   * @param {(row: any) => unknown} method
   * @param {any} row
   * @returns {Effect.Effect<void, unknown>}
   */
    callDbPersistence(label: string, method: (row: any) => unknown, row: any): Effect.Effect<void, unknown>;
    /**
   * @param {CorrelatedSmithersEvent} event
   * @returns {Effect.Effect<void, unknown>}
   */
    persistLog(event: CorrelatedSmithersEvent): Effect.Effect<void, unknown>;
    /**
   * @param {SmithersEvent} event
   * @returns {CorrelatedSmithersEvent}
   */
    attachCorrelation(event: SmithersEvent): CorrelatedSmithersEvent;
    /**
   * @param {CorrelatedSmithersEvent} event
   */
    eventLogAnnotations(event: CorrelatedSmithersEvent): {
        runId: string;
        eventType: "SupervisorStarted" | "SupervisorPollCompleted" | "RunAutoResumed" | "RunAutoResumeSkipped" | "RunStarted" | "RunStatusChanged" | "RunStateChanged" | "RunFinished" | "RunFailed" | "RunCancelled" | "RunContinuedAsNew" | "RunHijackRequested" | "RunHijacked" | "SandboxCreated" | "SandboxShipped" | "SandboxHeartbeat" | "SandboxBundleReceived" | "SandboxCompleted" | "SandboxFailed" | "SandboxDiffReviewRequested" | "SandboxDiffAccepted" | "SandboxDiffRejected" | "FrameCommitted" | "NodePending" | "NodeStarted" | "TaskHeartbeat" | "TaskHeartbeatTimeout" | "NodeFinished" | "NodeFailed" | "NodeCancelled" | "NodeSkipped" | "NodeRetrying" | "NodeWaitingApproval" | "NodeWaitingTimer" | "ApprovalRequested" | "ApprovalGranted" | "ApprovalAutoApproved" | "ApprovalDenied" | "ToolCallStarted" | "ToolCallFinished" | "NodeOutput" | "AgentEvent" | "RetryTaskStarted" | "RetryTaskFinished" | "RevertStarted" | "RevertFinished" | "TimeTravelStarted" | "TimeTravelFinished" | "TimeTravelJumped" | "WorkflowReloadDetected" | "WorkflowReloaded" | "WorkflowReloadFailed" | "WorkflowReloadUnsafe" | "ScorerStarted" | "ScorerFinished" | "ScorerFailed" | "TokenUsageReported" | "SnapshotCaptured" | "RunForked" | "ReplayStarted" | "MemoryFactSet" | "MemoryRecalled" | "MemoryMessageSaved" | "OpenApiToolCalled" | "TimerCreated" | "TimerFired" | "TimerCancelled" | "AgentTraceEvent" | "AgentTraceSummary" | "AgentSessionEvent";
    };
}
type CorrelationContext = _smithers_orchestrator_observability_correlation.CorrelationContext;
type CorrelatedSmithersEvent = SmithersEvent & {
    correlation?: CorrelationContext;
};
type SmithersEvent = _smithers_orchestrator_observability_SmithersEvent.SmithersEvent;

/**
 * Watch markdown artifacts under `.smithers/{tickets,plans,specs,proposals}` and
 * call `onSettle` with the affected DB doc paths after a trailing-idle debounce.
 *
 * @param {{
 *   cwd: string;
 *   onSettle: (paths: string[]) => void;
 *   debounceMs?: number;
 *   maxPendingPaths?: number;
 *   onDrop?: (info: { path: string; droppedTotal: number; pendingSize: number }) => void;
 *   watch?: (cwd: string, onChange: (relPath: string) => void) => ({ close: () => void } | null);
 *   setTimeoutFn?: (fn: () => void, ms: number) => unknown;
 *   clearTimeoutFn?: (handle: unknown) => void;
 * }} deps
 * @returns {{ close: () => void, flush: () => void, watching: boolean, droppedCount: () => number }}
 */
declare function createDocWatcher(deps: {
    cwd: string;
    onSettle: (paths: string[]) => void;
    debounceMs?: number;
    maxPendingPaths?: number;
    onDrop?: (info: {
        path: string;
        droppedTotal: number;
        pendingSize: number;
    }) => void;
    watch?: (cwd: string, onChange: (relPath: string) => void) => ({
        close: () => void;
    } | null);
    setTimeoutFn?: (fn: () => void, ms: number) => unknown;
    clearTimeoutFn?: (handle: unknown) => void;
}): {
    close: () => void;
    flush: () => void;
    watching: boolean;
    droppedCount: () => number;
};

/**
 * @param {unknown} value
 * @returns {| { name: string; sideEffect: boolean; idempotent: boolean; } | null}
 */
declare function getDefinedToolMetadata(value: unknown): {
    name: string;
    sideEffect: boolean;
    idempotent: boolean;
} | null;

type HumanRequestStatus$1 = "pending" | "answered" | "cancelled" | "expired";

type HumanRequestKind$1 = "ask" | "confirm" | "select" | "json";

/**
 * @param {string} runId
 * @param {string} nodeId
 * @param {number} iteration
 * @returns {string}
 */
declare function buildHumanRequestId(runId: string, nodeId: string, iteration: number): string;
/**
 * @param {Record<string, unknown> | null | undefined} meta
 * @returns {boolean}
 */
declare function isHumanTaskMeta(meta: Record<string, unknown> | null | undefined): boolean;
/**
 * @param {Record<string, unknown> | null | undefined} meta
 * @param {string} fallback
 * @returns {string}
 */
declare function getHumanTaskPrompt(meta: Record<string, unknown> | null | undefined, fallback: string): string;
/**
 * @param {{ timeoutAtMs?: number | null } | null | undefined} request
 * @returns {boolean}
 */
declare function isHumanRequestPastTimeout(request: {
    timeoutAtMs?: number | null;
} | null | undefined, nowMs?: number): boolean;
/**
 * @param {{ requestId: string; schemaJson: string | null }} request
 * @param {unknown} value
 * @returns {HumanRequestSchemaValidation}
 */
declare function validateHumanRequestValue(request: {
    requestId: string;
    schemaJson: string | null;
}, value: unknown): HumanRequestSchemaValidation;
/**
 * Build a unique request id for an ad-hoc, agent-initiated human ask.
 *
 * Unlike {@link buildHumanRequestId} (deterministic per run/node/iteration, used by
 * the declarative HumanTask node), an agent may raise more than one block per
 * node/iteration, so its ids must be unique. The caller supplies the uniqueness
 * token (e.g. a timestamp+random suffix) to keep this function pure/testable.
 *
 * @param {string} runId
 * @param {string} nodeId
 * @param {number} iteration
 * @param {string} unique
 * @returns {string}
 */
declare function buildAgentAskRequestId(runId: string, nodeId: string, iteration: number, unique: string): string;
/**
 * @typedef {object} BuildAgentAskRequestInput
 * @property {string} runId
 * @property {string} nodeId
 * @property {number} iteration
 * @property {string} prompt
 * @property {string} unique
 * @property {number} requestedAtMs
 * @property {HumanRequestKind} [kind]
 * @property {string | null} [schemaJson]
 * @property {string | null} [optionsJson]
 * @property {number | null} [timeoutAtMs]
 */
/**
 * Build the `_smithers_human_requests` row for an agent-initiated ask. The row is
 * `pending` and carries no approval, so `smithers human answer/cancel` resolves it
 * directly without touching the approval-node machinery.
 *
 * @param {BuildAgentAskRequestInput} input
 * @returns {Record<string, unknown>}
 */
declare function buildAgentAskRequestRow(input: BuildAgentAskRequestInput): Record<string, unknown>;
/**
 * @param {string} status
 * @returns {boolean}
 */
declare function isResolvedHumanRequestStatus(status: string): boolean;
/**
 * @typedef {object} HumanAnswerOutcome
 * @property {"answered" | "cancelled" | "expired" | "missing" | "aborted"} status
 * @property {string | null} [responseJson]
 * @property {string | null} [answeredBy]
 */
/**
 * Block until a pending human request is resolved (answered / cancelled / expired),
 * polling the durable store. Reusable by the CLI, the MCP `ask_human` tool, or any
 * other caller that needs to wait on a human decision. Pure poll loop — the only
 * dependency is a duck-typed adapter with `getHumanRequest` + `expireStaleHumanRequests`.
 *
 * @param {{ getHumanRequest: (id: string) => Promise<any>, expireStaleHumanRequests: (nowMs?: number) => Promise<unknown> }} adapter
 * @param {string} requestId
 * @param {object} [options]
 * @param {number} [options.pollIntervalMs]
 * @param {AbortSignal} [options.signal]
 * @param {() => number} [options.now]
 * @param {(ms: number, signal?: AbortSignal) => Promise<void>} [options.sleep]
 * @returns {Promise<HumanAnswerOutcome>}
 */
declare function waitForHumanAnswer(adapter: {
    getHumanRequest: (id: string) => Promise<any>;
    expireStaleHumanRequests: (nowMs?: number) => Promise<unknown>;
}, requestId: string, options?: {
    pollIntervalMs?: number | undefined;
    signal?: AbortSignal | undefined;
    now?: (() => number) | undefined;
    sleep?: ((ms: number, signal?: AbortSignal) => Promise<void>) | undefined;
}): Promise<HumanAnswerOutcome>;
/**
 * @typedef {{ ok: true; } | { ok: false; code: "HUMAN_REQUEST_SCHEMA_INVALID" | "HUMAN_REQUEST_VALIDATION_FAILED"; message: string; }} HumanRequestSchemaValidation
 */
/** @type {readonly ["ask", "confirm", "select", "json"]} */
declare const HUMAN_REQUEST_KINDS: readonly ["ask", "confirm", "select", "json"];
/** @type {readonly ["pending", "answered", "cancelled", "expired"]} */
declare const HUMAN_REQUEST_STATUSES: readonly ["pending", "answered", "cancelled", "expired"];
/**
 * Default node id used when an agent raises an ad-hoc human request mid-task and
 * no node context (env/flag) is available. listPendingHumanRequests LEFT-JOINs
 * nodes, so a synthetic node id still surfaces in `smithers human inbox`.
 * @type {string}
 */
declare const DEFAULT_AGENT_ASK_NODE_ID: string;
declare namespace __humanRequestInternals {
    export { formatValidationIssues };
    export { defaultPollSleep };
}
type BuildAgentAskRequestInput = {
    runId: string;
    nodeId: string;
    iteration: number;
    prompt: string;
    unique: string;
    requestedAtMs: number;
    kind?: HumanRequestKind$1 | undefined;
    schemaJson?: string | null | undefined;
    optionsJson?: string | null | undefined;
    timeoutAtMs?: number | null | undefined;
};
type HumanAnswerOutcome = {
    status: "answered" | "cancelled" | "expired" | "missing" | "aborted";
    responseJson?: string | null | undefined;
    answeredBy?: string | null | undefined;
};
type HumanRequestKind = HumanRequestKind$1;
type HumanRequestStatus = HumanRequestStatus$1;
type HumanRequestSchemaValidation = {
    ok: true;
} | {
    ok: false;
    code: "HUMAN_REQUEST_SCHEMA_INVALID" | "HUMAN_REQUEST_VALIDATION_FAILED";
    message: string;
};
/**
 * @param {{ issues?: Array<{ path?: PropertyKey[]; message?: string }> }} error
 */
declare function formatValidationIssues(error: {
    issues?: Array<{
        path?: PropertyKey[];
        message?: string;
    }>;
}): string;
/**
 * @param {number} ms
 * @param {AbortSignal} [signal]
 * @returns {Promise<void>}
 */
declare function defaultPollSleep(ms: number, signal?: AbortSignal): Promise<void>;

/**
 * @param {string | null | undefined} runtimeOwnerId
 * @returns {number | null}
 */
declare function parseRuntimeOwnerPid(runtimeOwnerId: string | null | undefined): number | null;
/**
 * @param {number} pid
 * @returns {boolean}
 */
declare function isPidAlive(pid: number): boolean;

type RalphMeta$1 = {
    id: string;
    until: boolean;
    maxIterations: number;
    onMaxReached: "fail" | "return-last";
    continueAsNewEvery?: number;
};

type ContinuationRequest$1 = {
    stateJson?: string;
};

type ScheduleResult$1 = {
    runnable: TaskDescriptor[];
    pendingExists: boolean;
    waitingApprovalExists: boolean;
    waitingEventExists: boolean;
    waitingTimerExists: boolean;
    readyRalphs: RalphMeta$1[];
    continuation?: ContinuationRequest$1;
    nextRetryAtMs?: number;
    fatalError?: string;
};

type RalphState$1 = {
    iteration: number;
    done: boolean;
};

type RalphStateMap$1 = Map<string, RalphState$1>;

type PlanNode$1 = {
    kind: "task";
    nodeId: string;
} | {
    kind: "sequence";
    children: PlanNode$1[];
} | {
    kind: "parallel";
    children: PlanNode$1[];
} | {
    kind: "ralph";
    id: string;
    children: PlanNode$1[];
    until: boolean;
    maxIterations: number;
    onMaxReached: "fail" | "return-last";
    continueAsNewEvery?: number;
} | {
    kind: "continue-as-new";
    stateJson?: string;
} | {
    kind: "group";
    children: PlanNode$1[];
} | {
    kind: "saga";
    id: string;
    actionChildren: PlanNode$1[];
    compensationChildren: PlanNode$1[];
    onFailure: "compensate" | "compensate-and-fail" | "fail";
} | {
    kind: "try-catch-finally";
    id: string;
    tryChildren: PlanNode$1[];
    catchChildren: PlanNode$1[];
    finallyChildren: PlanNode$1[];
};

/**
 * @type {(xml: XmlNode | null, ralphState?: RalphStateMap) => { plan: PlanNode | null; ralphs: RalphMeta[] }}
 */
declare const buildPlanTree: (xml: XmlNode | null, ralphState?: RalphStateMap) => {
    plan: PlanNode | null;
    ralphs: RalphMeta[];
};
/**
 * @type {(plan: PlanNode | null, states: TaskStateMap, descriptors: Map<string, _TaskDescriptor>, ralphState: RalphStateMap, retryWait: Map<string, number>, nowMs: number) => ScheduleResult}
 */
declare const scheduleTasks: (plan: PlanNode | null, states: TaskStateMap, descriptors: Map<string, _TaskDescriptor$6>, ralphState: RalphStateMap, retryWait: Map<string, number>, nowMs: number) => ScheduleResult;
type ContinuationRequest = ContinuationRequest$1;
type PlanNode = PlanNode$1;
type RalphMeta = RalphMeta$1;
type RalphState = RalphState$1;
type RalphStateMap = RalphStateMap$1;
type ReadonlyTaskStateMap = _smithers_orchestrator_scheduler.ReadonlyTaskStateMap;
type RetryWaitMap = _smithers_orchestrator_scheduler.RetryWaitMap;
type ScheduleResult = ScheduleResult$1;
type ScheduleSnapshot = _smithers_orchestrator_scheduler.ScheduleSnapshot;
type TaskRecord = _smithers_orchestrator_scheduler.TaskRecord;
type TaskState = _smithers_orchestrator_scheduler.TaskState;
type TaskStateMap = _smithers_orchestrator_scheduler.TaskStateMap;
type _TaskDescriptor$6 = _smithers_orchestrator_graph_TaskDescriptor.TaskDescriptor;
type XmlNode = _smithers_orchestrator_graph_XmlNode.XmlNode;

type SignalRunOptions$1 = {
    correlationId?: string | null;
    receivedBy?: string | null;
    timestampMs?: number;
};

/**
 * @param {SmithersDb} adapter
 * @param {string} runId
 * @param {string} signalName
 * @param {unknown} payload
 * @param {SignalRunOptions} [options]
 * @returns {Effect.Effect<{ runId: string; seq: number; signalName: string; correlationId: string | null; receivedAtMs: number }, SmithersError, never>}
 */
declare function signalRun(adapter: SmithersDb, runId: string, signalName: string, payload: unknown, options?: SignalRunOptions): Effect.Effect<{
    runId: string;
    seq: number;
    signalName: string;
    correlationId: string | null;
    receivedAtMs: number;
}, SmithersError, never>;
type SignalRunOptions = SignalRunOptions$1;

/**
 * @param {{
 *   enabled: boolean;
 *   cwd?: string;
 *   adapter: { upsertDocRow?: (row: Record<string, unknown>) => PromiseLike<unknown> };
 *   nowMs?: () => number;
 *   createWatcher?: typeof createDocWatcher;
 *   syncOnStart?: boolean;
 * }} options
 * @returns {Promise<{ active: boolean, flush: (paths?: readonly string[]) => Promise<{ upserted: number, tombstoned: number, skipped: number, dropped: number }>, stop: () => Promise<void> }>}
 */
declare function startDocFileSync(options: {
    enabled: boolean;
    cwd?: string;
    adapter: {
        upsertDocRow?: (row: Record<string, unknown>) => PromiseLike<unknown>;
    };
    nowMs?: () => number;
    createWatcher?: typeof createDocWatcher;
    syncOnStart?: boolean;
}): Promise<{
    active: boolean;
    flush: (paths?: readonly string[]) => Promise<{
        upserted: number;
        tombstoned: number;
        skipped: number;
        dropped: number;
    }>;
    stop: () => Promise<void>;
}>;

/**
 * @param {{
 *   cwd: string;
 *   adapter: { upsertDocRow: (row: Record<string, unknown>) => PromiseLike<unknown> };
 *   paths?: readonly string[];
 *   nowMs?: () => number;
 *   maxPaths?: number;
 * }} options
 * @returns {Promise<{ upserted: number, tombstoned: number, skipped: number, dropped: number }>}
 */
declare function syncDocsFromDisk(options: {
    cwd: string;
    adapter: {
        upsertDocRow: (row: Record<string, unknown>) => PromiseLike<unknown>;
    };
    paths?: readonly string[];
    nowMs?: () => number;
    maxPaths?: number;
}): Promise<{
    upserted: number;
    tombstoned: number;
    skipped: number;
    dropped: number;
}>;

type WatchTreeOptions$2 = {
    /** Patterns to ignore (directory basenames) */
    ignore?: string[];
    /** Debounce interval in ms (default: 100) */
    debounceMs?: number;
};

type OverlayOptions$2 = {
    /** Directory basenames to exclude from overlay */
    exclude?: string[];
};

type HotReloadEvent$2 = {
    type: "reloaded";
    generation: number;
    changedFiles: string[];
    newBuild: SmithersWorkflow$2<unknown>["build"];
} | {
    type: "failed";
    generation: number;
    changedFiles: string[];
    error: unknown;
} | {
    type: "unsafe";
    generation: number;
    changedFiles: string[];
    reason: string;
};

declare class WatchTree {
    /**
   * @param {string} rootDir
   * @param {WatchTreeOptions} [opts]
   */
    constructor(rootDir: string, opts?: WatchTreeOptions$1);
    watchers: any[];
    rootDir: string;
    ignore: string[];
    debounceMs: number;
    changedFiles: Set<any>;
    fileSignatures: Map<any, any>;
    debounceTimer: null;
    pollTimer: null;
    polling: boolean;
    pollingDisabled: boolean;
    currentPollIntervalMs: number;
    waitResolve: null;
    closed: boolean;
    /** Start watching. Call once. */
    start(): Promise<void>;
    /**
     * Returns a promise that resolves with changed file paths
     * the next time file changes are detected (after debounce).
     * Can be called repeatedly.
     */
    wait(): Promise<any>;
    /** Stop all watchers and clean up. */
    close(): void;
    startEffect(): Effect.Effect<void, _smithers_orchestrator_errors_toSmithersError.SmithersError, never>;
    waitEffect(): Effect.Effect<any, never, never>;
    /**
   * @param {string} name
   * @returns {boolean}
   */
    shouldIgnore(name: string): boolean;
    pollIntervalMs(): number;
    resetPollBackoff(): void;
    advancePollBackoff(changed: any): void;
    scheduleNextPoll(): void;
    startPolling(): void;
    pollOnce(): Promise<boolean>;
    /**
   * @param {string} dir
   * @returns {Promise<Map<string, string>>}
   */
    scanFileSignatures(dir: string): Promise<Map<string, string>>;
    /**
   * @param {string} dir
   * @param {Map<string, string>} files
   * @returns {Promise<void>}
   */
    scanDir(dir: string, files: Map<string, string>): Promise<void>;
    /**
   * @param {Map<string, string>} next
   */
    recordScanChanges(next: Map<string, string>): boolean;
    /**
   * @param {string} dir
   * @returns {Promise<void>}
   */
    watchDir(dir: string): Promise<void>;
    /**
   * @param {string} filePath
   */
    onFileChange(filePath: string): void;
    flush(): void;
}
type WatchTreeOptions$1 = WatchTreeOptions$2;

declare class HotWorkflowController {
    /**
   * @param {string} entryPath
   * @param {HotReloadOptions} [opts]
   */
    constructor(entryPath: string, opts?: HotReloadOptions);
    entryPath: string;
    hotRoot: string;
    outDir: string;
    maxGenerations: number;
    watcher: WatchTree;
    generation: number;
    closed: boolean;
    /** Initialize: start file watchers. Call once before using wait/reload. */
    init(): Promise<void>;
    /** Current generation number. */
    get gen(): number;
    /**
     * Wait for the next file change event.
     * Returns the list of changed file paths.
     * Use this in Promise.race with inflight tasks to wake the engine loop.
     */
    wait(): Promise<any>;
    /**
     * Perform a hot reload:
     * 1. Build a new generation overlay
     * 2. Import the workflow module from the overlay
     * 3. Validate the module
     * 4. Return the result (reloaded, failed, or unsafe)
     *
     * The caller is responsible for swapping workflow.build on success.
     *
     * @param {string[]} changedFiles
     * @returns {Promise<HotReloadEvent>}
     */
    reload(changedFiles: string[]): Promise<HotReloadEvent$1>;
    initEffect(): Effect.Effect<void, SmithersError, never>;
    waitEffect(): Effect.Effect<any, never, never>;
    /**
   * @param {string[]} changedFiles
   */
    reloadEffect(changedFiles: string[]): Effect.Effect<{
        type: string;
        generation: number;
        changedFiles: string[];
        error: SmithersError;
        newBuild?: undefined;
    } | {
        type: string;
        generation: number;
        changedFiles: string[];
        newBuild: any;
        error?: undefined;
    } | {
        type: string;
        generation: any;
        changedFiles: any;
        reason: string;
        error?: undefined;
    } | {
        type: string;
        generation: any;
        changedFiles: any;
        error: any;
        reason?: undefined;
    }, never, never>;
    /** Stop watchers and clean up overlay directory. */
    close(): Promise<void>;
    closeEffect(): Effect.Effect<any, any, any>;
}
type HotReloadEvent$1 = HotReloadEvent$2;
type HotReloadOptions = _smithers_orchestrator_driver_RunOptions.HotReloadOptions;

/**
 * @param {string} hotRoot
 * @param {string} outDir
 * @param {number} generation
 * @param {OverlayOptions} [opts]
 * @returns {Promise<string>}
 */
declare function buildOverlay(hotRoot: string, outDir: string, generation: number, opts?: OverlayOptions$1): Promise<string>;
/**
 * @param {string} outDir
 * @param {number} keepLast
 * @returns {Promise<void>}
 */
declare function cleanupGenerations(outDir: string, keepLast: number): Promise<void>;
/**
 * Resolve the overlay entry path given the original entry path,
 * the hot root, and the overlay generation directory.
 *
 * @param {string} entryPath
 * @param {string} hotRoot
 * @param {string} genDir
 * @returns {string}
 */
declare function resolveOverlayEntry(entryPath: string, hotRoot: string, genDir: string): string;
type OverlayOptions$1 = OverlayOptions$2;

type HotReloadEvent = HotReloadEvent$2;
type OverlayOptions = OverlayOptions$2;
type WatchTreeOptions = WatchTreeOptions$2;

type TaskActivityContext$1 = {
    attempt: number;
    idempotencyKey: string;
};

type TaskBridgeToolConfig$1 = {
    rootDir: string;
    allowNetwork: boolean;
    maxOutputBytes: number;
    toolTimeoutMs: number;
};

type HijackCompletion = {
    requestedAtMs: number;
    nodeId: string;
    iteration: number;
    attempt: number;
    engine: string;
    mode: "native-cli" | "conversation";
    resume?: string;
    messages?: unknown[];
    cwd: string;
};
type HijackState$1 = {
    request: {
        requestedAtMs: number;
        target?: string | null;
    } | null;
    completion: HijackCompletion | null;
};

type LegacyExecuteTaskFn$1 = (adapter: SmithersDb$1, db: BunSQLiteDatabase$2<Record<string, unknown>>, runId: string, desc: TaskDescriptor, descriptorMap: Map<string, TaskDescriptor>, inputTable: SQLiteTable$1, eventBus: EventBus$1, toolConfig: TaskBridgeToolConfig$1, workflowName: string, cacheEnabled: boolean, signal?: AbortSignal, disabledAgents?: Set<string>, runAbortController?: AbortController, hijackState?: HijackState$1) => Promise<void>;

declare function makeDurableDeferredBridgeExecutionId(adapter: _SmithersDb$4, runId: string, nodeId: string, iteration: number): string;
declare function makeApprovalDurableDeferred(nodeId: string): DurableDeferred.DurableDeferred<Schema.Struct<{
    approved: typeof Schema.Boolean;
    note: Schema.optional<typeof Schema.String>;
    decidedBy: Schema.NullOr<typeof Schema.String>;
    decisionJson: Schema.NullOr<typeof Schema.String>;
    autoApproved: typeof Schema.Boolean;
}>, typeof Schema.Never>;
declare function makeWaitForEventDurableDeferred(nodeId: string): DurableDeferred.DurableDeferred<Schema.Struct<{
    signalName: typeof Schema.String;
    correlationId: Schema.NullOr<typeof Schema.String>;
    payloadJson: typeof Schema.String;
    seq: typeof Schema.Number;
    receivedAtMs: typeof Schema.Number;
}>, typeof Schema.Never>;
declare function awaitApprovalDurableDeferred(adapter: _SmithersDb$4, runId: string, nodeId: string, iteration: number): Promise<BridgeDeferredResult>;
declare function awaitWaitForEventDurableDeferred(adapter: _SmithersDb$4, runId: string, nodeId: string, iteration: number): Promise<BridgeDeferredResult>;
declare function bridgeApprovalResolve(adapter: _SmithersDb$4, runId: string, nodeId: string, iteration: number, resolution: {
    approved: boolean;
    note?: string | null;
    decidedBy?: string | null;
    decisionJson?: string | null;
    autoApproved?: boolean;
}): Promise<void>;
declare function bridgeWaitForEventResolve(adapter: _SmithersDb$4, runId: string, nodeId: string, iteration: number, signal: WaitForEventSignalInput): Promise<void>;
declare function bridgeSignalResolve(adapter: _SmithersDb$4, runId: string, signal: WaitForEventSignalInput): Promise<void>;
type BridgeDeferredResult = {
    _tag: "Complete";
    exit: Exit.Exit<any, any>;
} | {
    _tag: "Pending";
};
type _SmithersDb$4 = _smithers_orchestrator_db_adapter.SmithersDb;
type WaitForEventSignalInput = {
    signalName: string;
    correlationId: string | null;
    payloadJson: string;
    seq: number;
    receivedAtMs: number;
};

/**
 * @param {_TaskDescriptor} desc
 * @returns {boolean}
 */
declare function isBridgeManagedTimerTask(desc: _TaskDescriptor$5): boolean;
/**
 * @param {_TaskDescriptor} desc
 * @returns {boolean}
 */
declare function isBridgeManagedWaitForEventTask(desc: _TaskDescriptor$5): boolean;
/**
 * @param {_SmithersDb} adapter
 * @param {BunSQLiteDatabase} db
 * @param {string} runId
 * @param {_TaskDescriptor} desc
 * @param {EventBus} eventBus
 * @param {DeferredBridgeStateEmitter} [emitStateEvent]
 * @returns {Promise<DeferredBridgeResolution>}
 */
declare function resolveDeferredTaskStateBridge(adapter: _SmithersDb$3, db: BunSQLiteDatabase$1, runId: string, desc: _TaskDescriptor$5, eventBus: EventBus, emitStateEvent?: DeferredBridgeStateEmitter): Promise<DeferredBridgeResolution>;
/**
 * @param {_SmithersDb} adapter
 * @param {string} runId
 * @param {EventBus} eventBus
 * @param {string} reason
 */
declare function cancelPendingTimersBridge(adapter: _SmithersDb$3, runId: string, eventBus: EventBus, reason: string): Promise<void>;
type DeferredBridgeState = "pending" | "waiting-approval" | "waiting-event" | "waiting-timer" | "finished" | "failed" | "skipped";
type DeferredBridgeResolution = {
    handled: false;
} | {
    handled: true;
    state: DeferredBridgeState;
};
type DeferredBridgeStateEmitter = (state: "pending" | "failed" | "skipped") => Promise<void>;
type _SmithersDb$3 = _smithers_orchestrator_db_adapter.SmithersDb;
type _TaskDescriptor$5 = _smithers_orchestrator_graph_TaskDescriptor.TaskDescriptor;
type BunSQLiteDatabase$1 = drizzle_orm_bun_sqlite.BunSQLiteDatabase<Record<string, unknown>>;

/**
 * @template T
 * @param {WorkflowMakeBridgeRuntime} runtime
 * @param {() => T} execute
 * @returns {T}
 */
declare function withWorkflowMakeBridgeRuntime<T>(runtime: WorkflowMakeBridgeRuntime, execute: () => T): T;
/**
 * @returns {| WorkflowMakeBridgeRuntime | undefined}
 */
declare function getWorkflowMakeBridgeRuntime(): WorkflowMakeBridgeRuntime | undefined;
/**
 * @returns {SchedulerWakeQueue}
 */
declare function createSchedulerWakeQueue(): SchedulerWakeQueue;
/**
 * @template Schema
 * @param {SmithersWorkflow<Schema>} workflow
 * @param {RunOptions & { runId: string }} opts
 * @param {RunBodyExecutor} executeBody
 * @returns {Promise<RunResult>}
 */
declare function runWorkflowWithMakeBridge<Schema>(workflow: SmithersWorkflow$1<Schema>, opts: RunOptions$1 & {
    runId: string;
}, executeBody: RunBodyExecutor): Promise<RunResult$1>;
type RunBodyResult = RunResult$1 | (RunResult$1 & {
    status: "continued";
    nextRunId: string;
});
type RunBodyExecutor = <Schema>(workflow: SmithersWorkflow$1<Schema>, opts: RunOptions$1) => Promise<RunBodyResult>;
type RunOptions$1 = _smithers_orchestrator_driver_RunOptions.RunOptions;
type RunResult$1 = _smithers_orchestrator_driver_RunResult.RunResult;
type SchedulerWakeQueue = {
    notify(): void;
    wait(): Promise<void>;
};
type SmithersWorkflow$1 = any;
type WorkflowEngineContext = effect.Context.Context<WorkflowEngine.WorkflowEngine>;
type WorkflowMakeBridgeRuntime = {
    readonly engineContext: WorkflowEngineContext;
    readonly scope: Scope.CloseableScope;
    readonly parentInstance: WorkflowEngine.WorkflowInstance["Type"];
    readonly executeBody: RunBodyExecutor;
    executeChildWorkflow: <Schema>(workflow: SmithersWorkflow$1<Schema>, opts: RunOptions$1 & {
        runId: string;
    }) => Promise<RunResult$1>;
};

type UnknownWorkerError = {
    _tag: "UnknownWorkerError";
    errorId: string;
    message: string;
};

type TaggedWorkerError = {
    _tag: "TaskAborted";
    message: string;
    details?: Record<string, unknown>;
    name?: string;
} | {
    _tag: "TaskTimeout";
    message: string;
    nodeId: string;
    attempt: number;
    timeoutMs: number;
} | {
    _tag: "TaskHeartbeatTimeout";
    message: string;
    nodeId: string;
    iteration: number;
    attempt: number;
    timeoutMs: number;
    staleForMs: number;
    lastHeartbeatAtMs: number;
} | {
    _tag: "RunNotFound";
    message: string;
    runId: string;
} | {
    _tag: "InvalidInput";
    message: string;
    details?: Record<string, unknown>;
} | {
    _tag: "DbWriteFailed";
    message: string;
    details?: Record<string, unknown>;
} | {
    _tag: "AgentCliError";
    message: string;
    details?: Record<string, unknown>;
} | {
    _tag: "WorkflowFailed";
    message: string;
    details?: Record<string, unknown>;
    status?: number;
};

type WorkerTaskError = TaggedWorkerError | UnknownWorkerError;

type TaskResult$1 = {
    _tag: "Success";
    executionId: string;
    terminal: boolean;
} | {
    _tag: "Failure";
    executionId: string;
    error: WorkerTaskError;
};

type TaskFailure$1 = Extract<TaskResult$1, {
    _tag: "Failure";
}>;

type WorkerTaskKind$1 = "agent" | "compute" | "static";

type WorkerDispatchKind$1 = "compute" | "static" | "legacy";

type WorkerTask$2 = {
    executionId: string;
    bridgeKey: string;
    workflowName: string;
    runId: string;
    nodeId: string;
    iteration: number;
    retries: number;
    taskKind: WorkerTaskKind$1;
    dispatchKind: WorkerDispatchKind$1;
};

/**
 * @param {string} bridgeKey
 * @param {string} workflowName
 * @param {string} runId
 * @param {_TaskDescriptor} desc
 * @param {WorkerDispatchKind} dispatchKind
 * @returns {WorkerTask}
 */
declare function makeWorkerTask(bridgeKey: string, workflowName: string, runId: string, desc: _TaskDescriptor$4, dispatchKind: WorkerDispatchKind): WorkerTask$1;
/**
 * @param {TaskResult} result
 * @returns {result is TaskFailure}
 */
declare function isTaskResultFailure(result: TaskResult): result is TaskFailure;
type WorkerTaskKind = WorkerTaskKind$1;
/** @typedef {import("@smithers-orchestrator/graph/TaskDescriptor").TaskDescriptor} _TaskDescriptor */
declare const WorkerTaskKind: Schema.Literal<["agent", "compute", "static"]>;
type WorkerDispatchKind = WorkerDispatchKind$1;
declare const WorkerDispatchKind: Schema.Literal<["compute", "static", "legacy"]>;
type WorkerTask$1 = WorkerTask$2;
declare const WorkerTask$1: Schema.Struct<{
    executionId: typeof Schema.String;
    bridgeKey: typeof Schema.String;
    workflowName: typeof Schema.String;
    runId: typeof Schema.String;
    nodeId: typeof Schema.String;
    iteration: typeof Schema.Number;
    retries: typeof Schema.Number;
    taskKind: Schema.Literal<["agent", "compute", "static"]>;
    dispatchKind: Schema.Literal<["compute", "static", "legacy"]>;
}>;
type TaskResult = TaskResult$1;
declare const TaskResult: Schema.Union<[Schema.Struct<{
    _tag: Schema.Literal<["Success"]>;
    executionId: typeof Schema.String;
    terminal: typeof Schema.Boolean;
}>, Schema.Struct<{
    _tag: Schema.Literal<["Failure"]>;
    executionId: typeof Schema.String;
    error: Schema.Union<[Schema.Union<[Schema.Struct<{
        _tag: Schema.Literal<["TaskAborted"]>;
        message: typeof Schema.String;
        details: Schema.optional<Schema.Record$<typeof Schema.String, typeof Schema.Unknown>>;
        name: Schema.optional<typeof Schema.String>;
    }>, Schema.Struct<{
        _tag: Schema.Literal<["TaskTimeout"]>;
        message: typeof Schema.String;
        nodeId: typeof Schema.String;
        attempt: typeof Schema.Number;
        timeoutMs: typeof Schema.Number;
    }>, Schema.Struct<{
        _tag: Schema.Literal<["TaskHeartbeatTimeout"]>;
        message: typeof Schema.String;
        nodeId: typeof Schema.String;
        iteration: typeof Schema.Number;
        attempt: typeof Schema.Number;
        timeoutMs: typeof Schema.Number;
        staleForMs: typeof Schema.Number;
        lastHeartbeatAtMs: typeof Schema.Number;
    }>, Schema.Struct<{
        _tag: Schema.Literal<["RunNotFound"]>;
        message: typeof Schema.String;
        runId: typeof Schema.String;
    }>, Schema.Struct<{
        _tag: Schema.Literal<["InvalidInput"]>;
        message: typeof Schema.String;
        details: Schema.optional<Schema.Record$<typeof Schema.String, typeof Schema.Unknown>>;
    }>, Schema.Struct<{
        _tag: Schema.Literal<["DbWriteFailed"]>;
        message: typeof Schema.String;
        details: Schema.optional<Schema.Record$<typeof Schema.String, typeof Schema.Unknown>>;
    }>, Schema.Struct<{
        _tag: Schema.Literal<["AgentCliError"]>;
        message: typeof Schema.String;
        details: Schema.optional<Schema.Record$<typeof Schema.String, typeof Schema.Unknown>>;
    }>, Schema.Struct<{
        _tag: Schema.Literal<["WorkflowFailed"]>;
        message: typeof Schema.String;
        details: Schema.optional<Schema.Record$<typeof Schema.String, typeof Schema.Unknown>>;
        status: Schema.optional<typeof Schema.Number>;
    }>]>, Schema.Struct<{
        _tag: Schema.Literal<["UnknownWorkerError"]>;
        errorId: typeof Schema.String;
        message: typeof Schema.String;
    }>]>;
}>]>;
declare const TaskWorkerEntity: Entity.Entity<"TaskWorker", Rpc.Rpc<"execute", Schema.Struct<{
    executionId: typeof Schema.String;
    bridgeKey: typeof Schema.String;
    workflowName: typeof Schema.String;
    runId: typeof Schema.String;
    nodeId: typeof Schema.String;
    iteration: typeof Schema.Number;
    retries: typeof Schema.Number;
    taskKind: Schema.Literal<["agent", "compute", "static"]>;
    dispatchKind: Schema.Literal<["compute", "static", "legacy"]>;
}>, Schema.Union<[Schema.Struct<{
    _tag: Schema.Literal<["Success"]>;
    executionId: typeof Schema.String;
    terminal: typeof Schema.Boolean;
}>, Schema.Struct<{
    _tag: Schema.Literal<["Failure"]>;
    executionId: typeof Schema.String;
    error: Schema.Union<[Schema.Union<[Schema.Struct<{
        _tag: Schema.Literal<["TaskAborted"]>;
        message: typeof Schema.String;
        details: Schema.optional<Schema.Record$<typeof Schema.String, typeof Schema.Unknown>>;
        name: Schema.optional<typeof Schema.String>;
    }>, Schema.Struct<{
        _tag: Schema.Literal<["TaskTimeout"]>;
        message: typeof Schema.String;
        nodeId: typeof Schema.String;
        attempt: typeof Schema.Number;
        timeoutMs: typeof Schema.Number;
    }>, Schema.Struct<{
        _tag: Schema.Literal<["TaskHeartbeatTimeout"]>;
        message: typeof Schema.String;
        nodeId: typeof Schema.String;
        iteration: typeof Schema.Number;
        attempt: typeof Schema.Number;
        timeoutMs: typeof Schema.Number;
        staleForMs: typeof Schema.Number;
        lastHeartbeatAtMs: typeof Schema.Number;
    }>, Schema.Struct<{
        _tag: Schema.Literal<["RunNotFound"]>;
        message: typeof Schema.String;
        runId: typeof Schema.String;
    }>, Schema.Struct<{
        _tag: Schema.Literal<["InvalidInput"]>;
        message: typeof Schema.String;
        details: Schema.optional<Schema.Record$<typeof Schema.String, typeof Schema.Unknown>>;
    }>, Schema.Struct<{
        _tag: Schema.Literal<["DbWriteFailed"]>;
        message: typeof Schema.String;
        details: Schema.optional<Schema.Record$<typeof Schema.String, typeof Schema.Unknown>>;
    }>, Schema.Struct<{
        _tag: Schema.Literal<["AgentCliError"]>;
        message: typeof Schema.String;
        details: Schema.optional<Schema.Record$<typeof Schema.String, typeof Schema.Unknown>>;
    }>, Schema.Struct<{
        _tag: Schema.Literal<["WorkflowFailed"]>;
        message: typeof Schema.String;
        details: Schema.optional<Schema.Record$<typeof Schema.String, typeof Schema.Unknown>>;
        status: Schema.optional<typeof Schema.Number>;
    }>]>, Schema.Struct<{
        _tag: Schema.Literal<["UnknownWorkerError"]>;
        errorId: typeof Schema.String;
        message: typeof Schema.String;
    }>]>;
}>]>, typeof Schema.Never, never>>;
type TaskFailure = TaskFailure$1;
type _TaskDescriptor$4 = _smithers_orchestrator_graph_TaskDescriptor.TaskDescriptor;

/**
 * @param {WorkerTask} task
 * @param {() => Promise<WorkerExecutionResult>} execute
 * @returns {Promise<WorkerExecutionResult>}
 */
declare function dispatchWorkerTask(task: WorkerTask, execute: () => Promise<WorkerExecutionResult>): Promise<WorkerExecutionResult>;
/**
 * @param {TaskWorkerDispatchSubscriber} subscriber
 * @returns {() => void}
 */
declare function subscribeTaskWorkerDispatches(subscriber: TaskWorkerDispatchSubscriber): () => void;
type TaskWorkerDispatchSubscriber = (task: WorkerTask) => void;
type WorkerExecutionResult = {
    terminal: boolean;
};
type WorkerTask = WorkerTask$2;

declare function executeTaskBridge(adapter: SmithersDb, db: _BunSQLiteDatabase$1, runId: string, desc: _TaskDescriptor$3, descriptorMap: Map<string, _TaskDescriptor$3>, inputTable: SQLiteTable, eventBus: EventBus, toolConfig: TaskBridgeToolConfig, workflowName: string, cacheEnabled: boolean, signal?: AbortSignal, disabledAgents?: Set<string>, runAbortController?: AbortController, hijackState?: HijackState, legacyExecuteTaskFn?: LegacyExecuteTaskFn): Promise<void>;
declare function executeTaskBridgeEffect(adapter: SmithersDb, db: _BunSQLiteDatabase$1, runId: string, desc: _TaskDescriptor$3, descriptorMap: Map<string, _TaskDescriptor$3>, inputTable: SQLiteTable, eventBus: EventBus, toolConfig: TaskBridgeToolConfig, workflowName: string, cacheEnabled: boolean, signal?: AbortSignal, disabledAgents?: Set<string>, runAbortController?: AbortController, hijackState?: HijackState, legacyExecuteTaskFn?: LegacyExecuteTaskFn): Effect.Effect<void, _smithers_orchestrator_errors_SmithersError.SmithersError, never>;
declare namespace __workflowBridgeInternals {
    export { classifyTaskAttempt };
    export { getNextTaskActivityAttempt };
    export { isRetryableBridgeTaskFailure };
    export { parseAttemptErrorCode };
    export { runEffectOrPromise };
    export { taskBridgeResultForError };
}
type HijackState = HijackState$1;
type LegacyExecuteTaskFn = LegacyExecuteTaskFn$1;
type TaskBridgeToolConfig = TaskBridgeToolConfig$1;
type _TaskDescriptor$3 = _smithers_orchestrator_graph_TaskDescriptor.TaskDescriptor;
type _TaskActivityContext = TaskActivityContext$1;
type _BunSQLiteDatabase$1 = drizzle_orm_bun_sqlite.BunSQLiteDatabase<Record<string, unknown>>;
type SQLiteTable = drizzle_orm_sqlite_core.SQLiteTable;
type BridgeManagedTaskKind = "compute" | "static" | "legacy";

/**
 * @param {SmithersDb} adapter
 * @param {string} runId
 * @param {_TaskDescriptor} desc
 * @param {_TaskActivityContext} context
 */
declare function classifyTaskAttempt(adapter: SmithersDb, runId: string, desc: _TaskDescriptor$3, context: _TaskActivityContext): Promise<{
    state: any;
    attempt: any;
    idempotencyKey: string;
}>;
/**
 * @param {SmithersDb} adapter
 * @param {string} runId
 * @param {_TaskDescriptor} desc
 */
declare function getNextTaskActivityAttempt(adapter: SmithersDb, runId: string, desc: _TaskDescriptor$3): Promise<any>;
/**
 * @param {{ errorJson?: string | null; metaJson?: string | null } | null} [attempt]
 */
declare function isRetryableBridgeTaskFailure(attempt?: {
    errorJson?: string | null;
    metaJson?: string | null;
} | null): boolean;
/**
 * @param {string | null} [errorJson]
 * @returns {string | null}
 */
declare function parseAttemptErrorCode(errorJson?: string | null): string | null;
/**
 * @template A
 * @param {Effect.Effect<A, unknown, never> | PromiseLike<A> | A} value
 * @returns {Promise<A>}
 */
declare function runEffectOrPromise<A>(value: Effect.Effect<A, unknown, never> | PromiseLike<A> | A): Promise<A>;
declare function taskBridgeResultForError(error: any): {
    terminal: boolean;
};

type TaskActivityRetryOptions$1 = {
    times: number;
    while?: (error: unknown) => boolean;
};

type ExecuteTaskActivityOptions$1 = {
    initialAttempt?: number;
    retry?: false | TaskActivityRetryOptions$1;
    includeAttemptInIdempotencyKey?: boolean;
};

/**
 * Upper bound on cached completed-activity results. Within a single run the
 * number of distinct idempotency keys is small, so this cap is a backstop that
 * prevents the module-level cache from growing without limit across the many
 * runs handled by a long-running gateway. Exported for tests.
 * @type {number}
 */
declare const COMPLETED_ACTIVITY_RESULTS_MAX: number;
declare function completedActivityResultsSize(): number;
declare class RetriableTaskFailure extends Error {
    /**
   * @param {string} nodeId
   * @param {number} attempt
   */
    constructor(nodeId: string, attempt: number);
    nodeId: string;
    attempt: number;
}
declare function makeTaskBridgeKey(adapter: _SmithersDb$2, workflowName: string, runId: string, desc: _TaskDescriptor$2): string;
declare function makeTaskActivity<A>(desc: _TaskDescriptor$2, executeFn: (context: TaskActivityContext) => Promise<A> | A, options?: Pick<ExecuteTaskActivityOptions, "includeAttemptInIdempotencyKey">): Activity.Activity<typeof Schema.Unknown, typeof Schema.Unknown, never>;
declare function executeTaskActivity<A>(adapter: _SmithersDb$2, workflowName: string, runId: string, desc: _TaskDescriptor$2, executeFn: (context: TaskActivityContext) => Promise<A> | A, options?: ExecuteTaskActivityOptions): Promise<A>;
type TaskActivityRetryOptions = TaskActivityRetryOptions$1;
type ExecuteTaskActivityOptions = ExecuteTaskActivityOptions$1;
type TaskActivityContext = TaskActivityContext$1;
type _SmithersDb$2 = _smithers_orchestrator_db_adapter.SmithersDb;
type _TaskDescriptor$2 = _smithers_orchestrator_graph_TaskDescriptor.TaskDescriptor;

/**
 * @returns {TaskAborted}
 */
declare function makeAbortError(message?: string): TaskAborted;
/**
 * @param {AbortController} controller
 * @param {AbortSignal} [signal]
 */
declare function wireAbortSignal(controller: AbortController, signal?: AbortSignal): () => void;
/**
 * @param {string | null} [metaJson]
 * @returns {Record<string, unknown>}
 */
declare function parseAttemptMetaJson(metaJson?: string | null): Record<string, unknown>;

type SmithersSqliteOptions$1 = {
    filename: string;
};

type AnySchema$1 = Schema.Schema<unknown, unknown, never>;
type AnyEffect$1 = unknown | Promise<unknown> | Effect.Effect<unknown, unknown, unknown>;
type BuilderStepContext$1 = Record<string, unknown> & {
    input: unknown;
    executionId: string;
    stepId: string;
    attempt: number;
    signal: AbortSignal;
    iteration: number;
    heartbeat: (data?: unknown) => void;
    lastHeartbeat: unknown | null;
};
type ApprovalOptions$1 = {
    needs?: Record<string, BuilderStepHandle$1>;
    request: (ctx: Record<string, unknown>) => {
        title: string;
        summary?: string | null;
    };
    onDeny?: "fail" | "continue" | "skip";
};
type BuilderStepHandle$1 = {
    kind: "step" | "approval";
    id: string;
    localId: string;
    tableKey: string;
    tableName: string;
    table: SQLiteTable$1;
    output: AnySchema$1;
    needs: Record<string, BuilderStepHandle$1>;
    run?: (ctx: BuilderStepContext$1) => AnyEffect$1;
    request?: ApprovalOptions$1["request"];
    onDeny?: "fail" | "continue" | "skip";
    retries: number;
    retryPolicy?: RetryPolicy$1;
    timeoutMs: number | null;
    skipIf?: (ctx: BuilderStepContext$1) => boolean;
    loopId?: string;
    cache?: CachePolicy;
};

type SequenceNode = {
    kind: "sequence";
    children: BuilderNode$1[];
};
type ParallelNode = {
    kind: "parallel";
    children: BuilderNode$1[];
    maxConcurrency?: number;
};
type LoopNode = {
    kind: "loop";
    id?: string;
    children: BuilderNode$1;
    until: (outputs: Record<string, unknown>) => boolean;
    maxIterations?: number;
    onMaxReached?: "fail" | "return-last";
    handles?: BuilderStepHandle$1[];
};
type MatchNode = {
    kind: "match";
    source: BuilderStepHandle$1;
    when: (value: unknown) => boolean;
    then: BuilderNode$1;
    else?: BuilderNode$1;
};
type BranchNode = {
    kind: "branch";
    condition: (ctx: Record<string, unknown>) => boolean;
    needs?: Record<string, BuilderStepHandle$1>;
    then: BuilderNode$1;
    else?: BuilderNode$1;
};
type WorktreeNode = {
    kind: "worktree";
    id?: string;
    path: string;
    branch?: string;
    skipIf?: (ctx: Record<string, unknown>) => boolean;
    needs?: Record<string, BuilderStepHandle$1>;
    children: BuilderNode$1;
};
type BuilderNode$1 = BuilderStepHandle$1 | SequenceNode | ParallelNode | LoopNode | MatchNode | BranchNode | WorktreeNode;

/**
 * @param {{ status?: string | null; heartbeatAtMs?: number | null } | null | undefined} run
 * @returns {boolean}
 */
declare function isRunHeartbeatFresh(run: {
    status?: string | null;
    heartbeatAtMs?: number | null;
} | null | undefined, now?: number): boolean;
/**
 * @param {{ _?: { fullSchema?: Record<string, unknown>; schema?: Record<string, unknown> }; schema?: Record<string, unknown> }} db
 * @returns {Record<string, unknown>}
 */
declare function resolveSchema(db: {
    _?: {
        fullSchema?: Record<string, unknown>;
        schema?: Record<string, unknown>;
    };
    schema?: Record<string, unknown>;
}): Record<string, unknown>;
/**
 * @template Schema
 * @param {SmithersWorkflow<Schema>} workflow
 * @param {SmithersCtx<unknown>} ctx
 * @param {{ baseRootDir?: string; workflowPath?: string | null }} [opts]
 * @returns {Effect.Effect<GraphSnapshot, SmithersError>}
 */
declare function renderFrame<Schema>(workflow: SmithersWorkflow<Schema>, ctx: SmithersCtx<unknown>, opts?: {
    baseRootDir?: string;
    workflowPath?: string | null;
}): Effect.Effect<GraphSnapshot, SmithersError>;
/**
 * @template Schema
 * @param {SmithersWorkflow<Schema>} workflow
 * @param {RunOptions} opts
 * @returns {Effect.Effect<RunResult, SmithersError>}
 */
declare function runWorkflow<Schema>(workflow: SmithersWorkflow<Schema>, opts: RunOptions): Effect.Effect<RunResult, SmithersError>;
type GraphSnapshot = _smithers_orchestrator_graph_GraphSnapshot.GraphSnapshot;
type RunOptions = _smithers_orchestrator_driver_RunOptions.RunOptions;
type RunResult = _smithers_orchestrator_driver_RunResult.RunResult;
type SmithersWorkflow = any;

/**
 * @param {{ name: string; input: AnySchema }} options
 */
declare function workflow(options: {
    name: string;
    input: AnySchema;
}): {
    /**
     * Finalize the workflow definition. Compiles the graph expression tree to a
     * BuilderNode tree, allocates step handles with active prefixes, and returns
     * a runnable workflow.
     *
     * @param {WorkflowGraph} graph
     */
    from(graph: WorkflowGraph): {
        node: BuilderNode$1;
        /**
         * @param {unknown} input
         * @param {Omit<Parameters<typeof runWorkflow>[1], "input">} [opts]
         */
        execute(input: unknown, opts?: Omit<Parameters<typeof runWorkflow>[1], "input">): Effect.Effect<any, any, any>;
    };
    /**
     * @param {string} id
     * @param {StepOptions} options
     */
    step: (id: string, options: StepOptions) => WorkflowGraph;
    /**
     * @param {string} id
     * @param {ApprovalOptions} options
     */
    approval: (id: string, options: ApprovalOptions) => WorkflowGraph;
    /**
     * @param {WorkflowGraph[]} children
     */
    sequence: (...children: WorkflowGraph[]) => WorkflowGraph;
    parallel: (...args: any[]) => WorkflowGraph;
    match: (source: any, options: any) => WorkflowGraph;
    branch: (options: any) => WorkflowGraph;
    loop: (options: any) => WorkflowGraph;
    worktree: (options: any) => WorkflowGraph;
    scope: (instanceId: any, child: any) => WorkflowGraph;
};
/**
 * Build a graph fragment whose steps live across workflows. Same constructors as
 * a workflow handle, minus `from` — fragments are values, not workflows. They compile
 * when mounted into a real workflow via `G.scope(instanceId, fragment)`.
 *
 * The input schema is preserved on the returned fragment as `inputSchema` (rather
 * than silently discarded) so a mount point can validate the inputs it passes.
 *
 * @param {AnySchema} inputSchema
 */
declare function fragment(inputSchema: AnySchema): {
    inputSchema: Schema.Schema<unknown, unknown, never>;
    /**
     * @param {string} id
     * @param {StepOptions} options
     */
    step: (id: string, options: StepOptions) => WorkflowGraph;
    /**
     * @param {string} id
     * @param {ApprovalOptions} options
     */
    approval: (id: string, options: ApprovalOptions) => WorkflowGraph;
    /**
     * @param {WorkflowGraph[]} children
     */
    sequence: (...children: WorkflowGraph[]) => WorkflowGraph;
    parallel: (...args: any[]) => WorkflowGraph;
    match: (source: any, options: any) => WorkflowGraph;
    branch: (options: any) => WorkflowGraph;
    loop: (options: any) => WorkflowGraph;
    worktree: (options: any) => WorkflowGraph;
    scope: (instanceId: any, child: any) => WorkflowGraph;
};
/** @type {{ sqlite: typeof sqlite; postgres: typeof postgres; pglite: typeof pglite; workflow: typeof workflow; fragment: typeof fragment }} */
declare const Smithers: {
    sqlite: typeof sqlite;
    postgres: typeof postgres;
    pglite: typeof pglite;
    workflow: typeof workflow;
    fragment: typeof fragment;
};
declare namespace __builderInternals {
    export { ApprovalDecision };
    export { SmithersSqlite };
    export { annotateLoops };
    export { applyPrefixId };
    export { assertUniqueHandleIds };
    export { buildNeedsContext };
    export { buildUserContext };
    export { collectHandles };
    export { compileGraph };
    export { compileNeeds };
    export { createBuilder };
    export { createBuilderDb };
    export { createBuilderDbPostgres };
    export { createInputTable };
    export { createPayloadTable };
    export { decodeSchema };
    export { deriveRetryCount };
    export { deriveRetryPolicy };
    export { durationToMs };
    export { encodeSchema };
    export { evaluateSkip };
    export { executeStepHandle };
    export { extractResult };
    export { isBuilderNode };
    export { isWorkflowGraph };
    export { makeFactory };
    export { makeGraph };
    export { makeTableName };
    export { normalizeExecutionError };
    export { readHandle };
    export { readHandleMaybe };
    export { readLatestHandleResult };
    export { renderNode };
    export { resolveEffectResult };
    export { resolveHandleIteration };
    export { sanitizeIdentifier };
    export { sqlite };
    export { postgres };
    export { pglite };
    export { stripPersistedKeys };
}
type WorkflowGraph = {
    _tag: "WorkflowGraph";
    expr: unknown;
    pipe: (...fns: Array<(g: any) => any>) => any;
};
type AnySchema = effect.Schema.Schema<unknown, unknown, never>;
type AnyEffect = unknown | Promise<unknown> | effect.Effect.Effect<unknown, unknown, unknown>;
type ApprovalOptions = {
    needs?: Record<string, BuilderStepHandle>;
    request: (ctx: Record<string, unknown>) => {
        title: string;
        summary?: string | null;
    };
    onDeny?: "fail" | "continue" | "skip";
};
type BuilderNode = BuilderNode$1;
type BuilderStepContext = Record<string, unknown> & {
    input: unknown;
    executionId: string;
    stepId: string;
    attempt: number;
    signal: AbortSignal;
    iteration: number;
    heartbeat: (data?: unknown) => void;
    lastHeartbeat: unknown | null;
};
type BuilderStepHandle = BuilderStepHandle$1;
type RetryPolicy = _smithers_orchestrator_scheduler_RetryPolicy.RetryPolicy;
type SmithersSqliteOptions = SmithersSqliteOptions$1;
type StepOptions = {
    output: AnySchema;
    needs?: Record<string, BuilderStepHandle>;
    run?: (ctx: BuilderStepContext) => AnyEffect;
    retry?: unknown;
    retryPolicy?: RetryPolicy;
    timeout?: unknown;
    skipIf?: (ctx: BuilderStepContext) => boolean;
    cache?: _smithers_orchestrator_scheduler_CachePolicy.CachePolicy;
};
type BuilderApi = {
    step: (id: string, options: StepOptions) => BuilderStepHandle;
    approval: (id: string, options: ApprovalOptions) => BuilderStepHandle;
    sequence: (...nodes: BuilderNode[]) => BuilderNode;
    parallel: (...nodesOrOptions: [...BuilderNode[], {
        maxConcurrency?: number;
    }] | BuilderNode[]) => BuilderNode;
    loop: (options: {
        id?: string;
        children: BuilderNode;
        until: (outputs: Record<string, unknown>) => boolean;
        maxIterations?: number;
        onMaxReached?: "fail" | "return-last";
    }) => BuilderNode;
    match: (source: BuilderStepHandle, options: {
        when: (value: unknown) => boolean;
        then: () => BuilderNode;
        else?: () => BuilderNode;
    }) => BuilderNode;
    component: (instanceId: string, definition: ComponentDefinition, params?: Record<string, unknown>) => BuilderNode;
};
type BuiltSmithersWorkflow = {
    execute: (input: unknown, opts?: Omit<Parameters<typeof runWorkflow>[1], "input">) => effect.Effect.Effect<unknown, unknown, unknown>;
};
type WorkflowDefinitionBuilder = {
    build: (buildGraph: ($: BuilderApi) => BuilderNode) => BuiltSmithersWorkflow;
};
type ComponentDefinition = {
    kind: "component-definition";
    name: string;
    buildWithPrefix: (prefix: string, params?: Record<string, unknown>) => BuilderNode;
};
type ComponentDefinitionBuilder = {
    build: (buildGraph: ($: BuilderApi, params?: Record<string, unknown>) => BuilderNode) => ComponentDefinition;
};

/**
 * @param {SmithersSqliteOptions} options
 */
declare function sqlite(options: SmithersSqliteOptions): Layer.Layer<any, never, never>;
/**
 * Persist the workflow to a PostgreSQL database. `options.connectionString` (or
 * a node-postgres `options.connection` config) selects the server.
 * @param {{ connectionString?: string; connection?: object }} options
 */
declare function postgres(options: {
    connectionString?: string;
    connection?: object;
}): Layer.Layer<any, never, never>;
/**
 * Persist the workflow to an embedded PGlite database (Postgres-in-WASM),
 * exposed to the engine over the Postgres wire protocol via a local socket
 * server. `options.dataDir` persists to disk; omit it for an in-memory database.
 * @param {{ dataDir?: string }} [options]
 */
declare function pglite(options?: {
    dataDir?: string;
}): Layer.Layer<any, never, never>;
declare class ApprovalDecision {
}
/**
 * @typedef {import("effect").Schema.Schema<unknown, unknown, never>} AnySchema
 */
/**
 * @typedef {unknown | Promise<unknown> | import("effect").Effect.Effect<unknown, unknown, unknown>} AnyEffect
 */
/**
 * @typedef {{ needs?: Record<string, BuilderStepHandle>; request: (ctx: Record<string, unknown>) => { title: string; summary?: string | null; }; onDeny?: "fail" | "continue" | "skip"; }} ApprovalOptions
 */
/** @typedef {import("./BuilderNode.ts").BuilderNode} BuilderNode */
/**
 * @typedef {Record<string, unknown> & { input: unknown; executionId: string; stepId: string; attempt: number; signal: AbortSignal; iteration: number; heartbeat: (data?: unknown) => void; lastHeartbeat: unknown | null; }} BuilderStepContext
 */
/** @typedef {import("./BuilderStepHandle.ts").BuilderStepHandle} BuilderStepHandle */
/** @typedef {import("@smithers-orchestrator/scheduler/RetryPolicy").RetryPolicy} RetryPolicy */
/** @typedef {import("./SmithersSqliteOptions.ts").SmithersSqliteOptions} SmithersSqliteOptions */
/**
 * @typedef {{
 *   output: AnySchema;
 *   needs?: Record<string, BuilderStepHandle>;
 *   run?: (ctx: BuilderStepContext) => AnyEffect;
 *   retry?: unknown;
 *   retryPolicy?: RetryPolicy;
 *   timeout?: unknown;
 *   skipIf?: (ctx: BuilderStepContext) => boolean;
 *   cache?: import("@smithers-orchestrator/scheduler/CachePolicy").CachePolicy;
 * }} StepOptions
 */
/**
 * @typedef {{
 *   step: (id: string, options: StepOptions) => BuilderStepHandle;
 *   approval: (id: string, options: ApprovalOptions) => BuilderStepHandle;
 *   sequence: (...nodes: BuilderNode[]) => BuilderNode;
 *   parallel: (...nodesOrOptions: [...BuilderNode[], { maxConcurrency?: number }] | BuilderNode[]) => BuilderNode;
 *   loop: (options: { id?: string; children: BuilderNode; until: (outputs: Record<string, unknown>) => boolean; maxIterations?: number; onMaxReached?: "fail" | "return-last"; }) => BuilderNode;
 *   match: (source: BuilderStepHandle, options: { when: (value: unknown) => boolean; then: () => BuilderNode; else?: () => BuilderNode; }) => BuilderNode;
 *   component: (instanceId: string, definition: ComponentDefinition, params?: Record<string, unknown>) => BuilderNode;
 * }} BuilderApi
 */
/**
 * @typedef {{ execute: (input: unknown, opts?: Omit<Parameters<typeof runWorkflow>[1], "input">) => import("effect").Effect.Effect<unknown, unknown, unknown> }} BuiltSmithersWorkflow
 */
/**
 * @typedef {{ build: (buildGraph: ($: BuilderApi) => BuilderNode) => BuiltSmithersWorkflow }} WorkflowDefinitionBuilder
 */
/**
 * @typedef {{ kind: "component-definition"; name: string; buildWithPrefix: (prefix: string, params?: Record<string, unknown>) => BuilderNode }} ComponentDefinition
 */
/**
 * @typedef {{ build: (buildGraph: ($: BuilderApi, params?: Record<string, unknown>) => BuilderNode) => ComponentDefinition }} ComponentDefinitionBuilder
 */
declare const SmithersSqlite: Context.Tag<any, any>;
/**
 * @param {BuilderNode} node
 * @param {string} [activeLoopId]
 * @returns {BuilderStepHandle[]}
 */
declare function annotateLoops(node: BuilderNode, activeLoopId?: string): BuilderStepHandle[];
/**
 * @param {string} prefix
 * @param {string | undefined} id
 */
declare function applyPrefixId(prefix: string, id: string | undefined): string | undefined;
/**
 * @param {BuilderStepHandle[]} handles
 */
declare function assertUniqueHandleIds(handles: BuilderStepHandle[]): void;
/**
 * @param {Record<string, BuilderStepHandle> | undefined} needs
 * @param {any} ctx
 * @param {unknown} decodedInput
 * @param {ReturnType<typeof requireTaskRuntime>} [runtime]
 */
declare function buildNeedsContext(needs: Record<string, BuilderStepHandle> | undefined, ctx: any, decodedInput: unknown, runtime?: ReturnType<typeof requireTaskRuntime>): {
    input: unknown;
    executionId: any;
    stepId: any;
    attempt: any;
    signal: any;
    iteration: any;
    heartbeat: any;
    lastHeartbeat: any;
    loop: {
        iteration: any;
    };
};
/**
 * @param {BuilderStepHandle} handle
 * @param {any} ctx
 * @param {unknown} decodedInput
 * @param {ReturnType<typeof requireTaskRuntime>} [runtime]
 * @returns {BuilderStepContext}
 */
declare function buildUserContext(handle: BuilderStepHandle, ctx: any, decodedInput: unknown, runtime?: ReturnType<typeof requireTaskRuntime>): BuilderStepContext;
/**
 * @param {BuilderNode} node
 * @param {BuilderStepHandle[]} [out]
 */
declare function collectHandles(node: BuilderNode, out?: BuilderStepHandle[]): BuilderStepHandle$1[];
/**
 * Walk a graph expression tree and produce a BuilderNode tree at the active prefix.
 * Memoizes per (prefix, graph) so a value referenced as both a child and a needs source
 * compiles to a single handle, while reuse under different scopes produces distinct handles.
 *
 * @param {WorkflowGraph} graph
 * @param {string} [prefix]
 * @param {Map<string, Map<WorkflowGraph, BuilderNode>>} [memo]
 * @returns {BuilderNode}
 */
declare function compileGraph(graph: WorkflowGraph, prefix?: string, memo?: Map<string, Map<WorkflowGraph, BuilderNode>>): BuilderNode;
/**
 * @param {Record<string, WorkflowGraph> | undefined} needs
 * @param {string} prefix
 * @param {Map<string, Map<WorkflowGraph, BuilderNode>>} memo
 */
declare function compileNeeds(needs: Record<string, WorkflowGraph> | undefined, prefix: string, memo: Map<string, Map<WorkflowGraph, BuilderNode>>): {} | undefined;
/**
 * @returns {BuilderApi}
 */
declare function createBuilder(prefix?: string): BuilderApi;
/**
 * @param {string} filename
 * @param {BuilderStepHandle[]} handles
 */
declare function createBuilderDb(filename: string, handles: BuilderStepHandle[]): {
    sqlite: Database;
    db: drizzle_orm_bun_sqlite.BunSQLiteDatabase<{
        input: drizzle_orm_sqlite_core.SQLiteTableWithColumns<{
            name: "input";
            schema: undefined;
            columns: {
                runId: drizzle_orm_sqlite_core.SQLiteColumn<{
                    name: "run_id";
                    tableName: "input";
                    dataType: "string";
                    columnType: "SQLiteText";
                    data: string;
                    driverParam: string;
                    notNull: true;
                    hasDefault: false;
                    isPrimaryKey: true;
                    isAutoincrement: false;
                    hasRuntimeDefault: false;
                    enumValues: [string, ...string[]];
                    baseColumn: never;
                    identity: undefined;
                    generated: undefined;
                }, {}, {
                    length: number | undefined;
                }>;
                payload: drizzle_orm_sqlite_core.SQLiteColumn<{
                    name: "payload";
                    tableName: "input";
                    dataType: "json";
                    columnType: "SQLiteTextJson";
                    data: any;
                    driverParam: string;
                    notNull: false;
                    hasDefault: false;
                    isPrimaryKey: false;
                    isAutoincrement: false;
                    hasRuntimeDefault: false;
                    enumValues: undefined;
                    baseColumn: never;
                    identity: undefined;
                    generated: undefined;
                }, {}, {
                    $type: any;
                }>;
            };
            dialect: "sqlite";
        }>;
    }> & {
        $client: Database;
    };
    inputTable: drizzle_orm_sqlite_core.SQLiteTableWithColumns<{
        name: "input";
        schema: undefined;
        columns: {
            runId: drizzle_orm_sqlite_core.SQLiteColumn<{
                name: "run_id";
                tableName: "input";
                dataType: "string";
                columnType: "SQLiteText";
                data: string;
                driverParam: string;
                notNull: true;
                hasDefault: false;
                isPrimaryKey: true;
                isAutoincrement: false;
                hasRuntimeDefault: false;
                enumValues: [string, ...string[]];
                baseColumn: never;
                identity: undefined;
                generated: undefined;
            }, {}, {
                length: number | undefined;
            }>;
            payload: drizzle_orm_sqlite_core.SQLiteColumn<{
                name: "payload";
                tableName: "input";
                dataType: "json";
                columnType: "SQLiteTextJson";
                data: any;
                driverParam: string;
                notNull: false;
                hasDefault: false;
                isPrimaryKey: false;
                isAutoincrement: false;
                hasRuntimeDefault: false;
                enumValues: undefined;
                baseColumn: never;
                identity: undefined;
                generated: undefined;
            }, {}, {
                $type: any;
            }>;
        };
        dialect: "sqlite";
    }>;
    schema: {
        input: drizzle_orm_sqlite_core.SQLiteTableWithColumns<{
            name: "input";
            schema: undefined;
            columns: {
                runId: drizzle_orm_sqlite_core.SQLiteColumn<{
                    name: "run_id";
                    tableName: "input";
                    dataType: "string";
                    columnType: "SQLiteText";
                    data: string;
                    driverParam: string;
                    notNull: true;
                    hasDefault: false;
                    isPrimaryKey: true;
                    isAutoincrement: false;
                    hasRuntimeDefault: false;
                    enumValues: [string, ...string[]];
                    baseColumn: never;
                    identity: undefined;
                    generated: undefined;
                }, {}, {
                    length: number | undefined;
                }>;
                payload: drizzle_orm_sqlite_core.SQLiteColumn<{
                    name: "payload";
                    tableName: "input";
                    dataType: "json";
                    columnType: "SQLiteTextJson";
                    data: any;
                    driverParam: string;
                    notNull: false;
                    hasDefault: false;
                    isPrimaryKey: false;
                    isAutoincrement: false;
                    hasRuntimeDefault: false;
                    enumValues: undefined;
                    baseColumn: never;
                    identity: undefined;
                    generated: undefined;
                }, {}, {
                    $type: any;
                }>;
            };
            dialect: "sqlite";
        }>;
    };
};
/**
 * PostgreSQL/PGlite equivalent of {@link createBuilderDb}. Boots a node-postgres
 * connection (for `provider: "postgres"`) or an embedded PGlite exposed over the
 * Postgres wire protocol by a local socket server (for `provider: "pglite"`),
 * ensures the durable `_smithers_*` schema, and creates the input + per-handle
 * output tables. Returns a dialect descriptor consumed by SmithersDb plus a
 * teardown hook.
 *
 * @param {{ provider: "postgres" | "pglite"; connectionString?: string; connection?: object; dataDir?: string }} config
 * @param {BuilderStepHandle[]} handles
 */
declare function createBuilderDbPostgres(config: {
    provider: "postgres" | "pglite";
    connectionString?: string;
    connection?: object;
    dataDir?: string;
}, handles: BuilderStepHandle[]): Promise<{
    db: {
        dialect: string;
        connection: any;
        schema: {
            input: drizzle_orm_sqlite_core.SQLiteTableWithColumns<{
                name: "input";
                schema: undefined;
                columns: {
                    runId: drizzle_orm_sqlite_core.SQLiteColumn<{
                        name: "run_id";
                        tableName: "input";
                        dataType: "string";
                        columnType: "SQLiteText";
                        data: string;
                        driverParam: string;
                        notNull: true;
                        hasDefault: false;
                        isPrimaryKey: true;
                        isAutoincrement: false;
                        hasRuntimeDefault: false;
                        enumValues: [string, ...string[]];
                        baseColumn: never;
                        identity: undefined;
                        generated: undefined;
                    }, {}, {
                        length: number | undefined;
                    }>;
                    payload: drizzle_orm_sqlite_core.SQLiteColumn<{
                        name: "payload";
                        tableName: "input";
                        dataType: "json";
                        columnType: "SQLiteTextJson";
                        data: any;
                        driverParam: string;
                        notNull: false;
                        hasDefault: false;
                        isPrimaryKey: false;
                        isAutoincrement: false;
                        hasRuntimeDefault: false;
                        enumValues: undefined;
                        baseColumn: never;
                        identity: undefined;
                        generated: undefined;
                    }, {}, {
                        $type: any;
                    }>;
                };
                dialect: "sqlite";
            }>;
        };
    };
    connection: any;
    close: () => Promise<void>;
}>;
declare function createInputTable(): drizzle_orm_sqlite_core.SQLiteTableWithColumns<{
    name: "input";
    schema: undefined;
    columns: {
        runId: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "run_id";
            tableName: "input";
            dataType: "string";
            columnType: "SQLiteText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: true;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        payload: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "payload";
            tableName: "input";
            dataType: "json";
            columnType: "SQLiteTextJson";
            data: any;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            $type: any;
        }>;
    };
    dialect: "sqlite";
}>;
/**
 * @param {string} name
 */
declare function createPayloadTable(name: string): drizzle_orm_sqlite_core.SQLiteTableWithColumns<{
    name: string;
    schema: undefined;
    columns: {
        runId: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "run_id";
            tableName: string;
            dataType: "string";
            columnType: "SQLiteText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        nodeId: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "node_id";
            tableName: string;
            dataType: "string";
            columnType: "SQLiteText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        iteration: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "iteration";
            tableName: string;
            dataType: "number";
            columnType: "SQLiteInteger";
            data: number;
            driverParam: number;
            notNull: true;
            hasDefault: true;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        payload: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "payload";
            tableName: string;
            dataType: "json";
            columnType: "SQLiteTextJson";
            data: any;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            $type: any;
        }>;
    };
    dialect: "sqlite";
}>;
/**
 * @template T
 * @param {AnySchema} schema
 * @param {unknown} value
 * @returns {T}
 */
declare function decodeSchema<T>(schema: AnySchema, value: unknown): T;
/**
 * @param {unknown} retry
 * @returns {number}
 */
declare function deriveRetryCount(retry: unknown): number;
/**
 * @param {unknown} retry
 * @returns {RetryPolicy | undefined}
 */
declare function deriveRetryPolicy(retry: unknown): RetryPolicy | undefined;
/**
 * @param {unknown} input
 * @returns {number | null}
 */
declare function durationToMs(input: unknown): number | null;
/**
 * @param {AnySchema} schema
 * @param {unknown} value
 */
declare function encodeSchema(schema: AnySchema, value: unknown): unknown;
/**
 * @param {BuilderStepHandle} handle
 * @param {any} ctx
 * @param {unknown} decodedInput
 * @returns {boolean}
 */
declare function evaluateSkip(handle: BuilderStepHandle, ctx: any, decodedInput: unknown): boolean;
/**
 * @param {BuilderStepHandle} handle
 * @param {any} ctx
 * @param {unknown} decodedInput
 * @param {any} env
 */
declare function executeStepHandle(handle: BuilderStepHandle, ctx: any, decodedInput: unknown, env: any): Promise<unknown>;
/**
 * @param {BuilderNode} node
 * @param {any} db
 * @param {string} runId
 * @param {unknown} [decodedInput]
 * @returns {Promise<unknown>}
 */
declare function extractResult(node: BuilderNode, db: any, runId: string, decodedInput?: unknown): Promise<unknown>;
/**
 * @param {unknown} value
 * @returns {value is BuilderNode}
 */
declare function isBuilderNode(value: unknown): value is BuilderNode;
/**
 * @typedef {{ _tag: "WorkflowGraph"; expr: unknown; pipe: (...fns: Array<(g: any) => any>) => any }} WorkflowGraph
 */
/**
 * @param {unknown} value
 * @returns {value is WorkflowGraph}
 */
declare function isWorkflowGraph(value: unknown): value is WorkflowGraph;
/**
 * Build the graph constructors shared by Smithers.workflow and Smithers.fragment.
 */
declare function makeFactory(): {
    /**
     * @param {string} id
     * @param {StepOptions} options
     */
    step: (id: string, options: StepOptions) => WorkflowGraph;
    /**
     * @param {string} id
     * @param {ApprovalOptions} options
     */
    approval: (id: string, options: ApprovalOptions) => WorkflowGraph;
    /**
     * @param {WorkflowGraph[]} children
     */
    sequence: (...children: WorkflowGraph[]) => WorkflowGraph;
    parallel: (...args: any[]) => WorkflowGraph;
    match: (source: any, options: any) => WorkflowGraph;
    branch: (options: any) => WorkflowGraph;
    loop: (options: any) => WorkflowGraph;
    worktree: (options: any) => WorkflowGraph;
    scope: (instanceId: any, child: any) => WorkflowGraph;
};
/**
 * @param {unknown} expr
 * @returns {WorkflowGraph}
 */
declare function makeGraph(expr: unknown): WorkflowGraph;
/**
 * @param {string} id
 * @returns {string}
 */
declare function makeTableName(id: string): string;
/**
 * @param {{ status: string; error?: unknown }} result
 */
declare function normalizeExecutionError(result: {
    status: string;
    error?: unknown;
}): Error;
/**
 * @param {BuilderStepHandle} handle
 * @param {any} ctx
 * @returns {unknown}
 */
declare function readHandle(handle: BuilderStepHandle, ctx: any): unknown;
/**
 * @param {BuilderStepHandle} handle
 * @param {any} ctx
 * @returns {unknown}
 */
declare function readHandleMaybe(handle: BuilderStepHandle, ctx: any): unknown;
/**
 * @param {any} db
 * @param {string} runId
 * @param {BuilderStepHandle} handle
 */
declare function readLatestHandleResult(db: any, runId: string, handle: BuilderStepHandle): Promise<any>;
/**
 * @param {BuilderNode} node
 * @param {any} ctx
 * @param {unknown} decodedInput
 * @param {any} env
 * @returns {React.ReactNode}
 */
declare function renderNode(node: BuilderNode, ctx: any, decodedInput: unknown, env: any): React.ReactNode;
/**
 * @param {unknown} value
 * @param {any} env
 * @param {AbortSignal} signal
 */
declare function resolveEffectResult(value: unknown, env: any, signal: AbortSignal): Promise<unknown>;
/**
 * @param {BuilderStepHandle} handle
 * @param {{ iteration?: number; iterations?: Record<string, number>; }} ctx
 * @returns {number}
 */
declare function resolveHandleIteration(handle: BuilderStepHandle, ctx: {
    iteration?: number;
    iterations?: Record<string, number>;
}): number;
/**
 * @param {string} value
 * @returns {string}
 */
declare function sanitizeIdentifier(value: string): string;
/**
 * @param {Record<string, unknown>} row
 */
declare function stripPersistedKeys(row: Record<string, unknown>): {} | null;

declare function canExecuteBridgeManagedComputeTask(desc: _TaskDescriptor$1, cacheEnabled: boolean): boolean;
declare function executeComputeTaskBridge(adapter: _SmithersDb$1, db: _BunSQLiteDatabase, runId: string, desc: _TaskDescriptor$1, eventBus: EventBus, toolConfig: ComputeTaskBridgeToolConfig, workflowName: string, signal?: AbortSignal): Promise<void>;
declare namespace __computeTaskBridgeInternals {
    export { TASK_HEARTBEAT_MAX_PAYLOAD_BYTES };
    export { TASK_HEARTBEAT_THROTTLE_MS };
    export { TASK_HEARTBEAT_TIMEOUT_CHECK_MS };
    export { heartbeatTimeoutReasonFromAbort };
    export { isAbortError$1 as isAbortError };
    export { isHeartbeatPayloadValidationError };
    export { linkEffectAbortSignal };
    export { parseAttemptHeartbeatData };
    export { serializeHeartbeatPayload };
    export { validateHeartbeatValue };
}
type ComputeTaskBridgeToolConfig = {
    rootDir: string;
};
type _SmithersDb$1 = _smithers_orchestrator_db_adapter.SmithersDb;
type _TaskDescriptor$1 = _smithers_orchestrator_graph_TaskDescriptor.TaskDescriptor;
type _BunSQLiteDatabase = drizzle_orm_bun_sqlite.BunSQLiteDatabase<Record<string, unknown>>;
declare const TASK_HEARTBEAT_MAX_PAYLOAD_BYTES: 1000000;
/**
 * @typedef {{ rootDir: string; }} ComputeTaskBridgeToolConfig
 */
/** @typedef {import("@smithers-orchestrator/db/adapter").SmithersDb} _SmithersDb */
/** @typedef {import("@smithers-orchestrator/graph/TaskDescriptor").TaskDescriptor} _TaskDescriptor */
/** @typedef {import("drizzle-orm/bun-sqlite").BunSQLiteDatabase<Record<string, unknown>>} _BunSQLiteDatabase */
declare const TASK_HEARTBEAT_THROTTLE_MS: 500;
declare const TASK_HEARTBEAT_TIMEOUT_CHECK_MS: 250;
/**
 * @param {AbortSignal | undefined} signal
 * @param {unknown} err
 * @returns {unknown | null}
 */
declare function heartbeatTimeoutReasonFromAbort(signal: AbortSignal | undefined, err: unknown): unknown | null;
/**
 * @param {unknown} err
 * @returns {boolean}
 */
declare function isAbortError$1(err: unknown): boolean;
/**
 * @param {unknown} err
 * @returns {boolean}
 */
declare function isHeartbeatPayloadValidationError(err: unknown): boolean;
/**
 * @param {AbortController} controller
 * @param {AbortSignal} signal
 * @returns {() => void}
 */
declare function linkEffectAbortSignal(controller: AbortController, signal: AbortSignal): () => void;
/**
 * @param {string | null} [heartbeatDataJson]
 * @returns {unknown | null}
 */
declare function parseAttemptHeartbeatData(heartbeatDataJson?: string | null): unknown | null;
/**
 * @param {unknown} data
 * @returns {{ heartbeatDataJson: string; dataSizeBytes: number; }}
 */
declare function serializeHeartbeatPayload(data: unknown): {
    heartbeatDataJson: string;
    dataSizeBytes: number;
};
/**
 * @param {unknown} value
 * @param {string} path
 * @param {Set<unknown>} seen
 */
declare function validateHeartbeatValue(value: unknown, path: string, seen: Set<unknown>): void;

type FilePatch$1 = {
    path: string;
    operation: "add" | "modify" | "delete";
    diff: string;
    binaryContent?: string;
};

type DiffBundle$1 = {
    seq: number;
    baseRef: string;
    patches: FilePatch$1[];
};

/**
 * Compute a diff bundle strictly between two immutable refs.
 *
 * Unlike {@link computeDiffBundle}, this variant does NOT read the working
 * tree or untracked files. It is the preferred entry point for historical
 * diffs (e.g. the `getNodeDiff` RPC) because it is read-only and cannot be
 * contaminated by concurrent runs mutating the checkout.
 *
 * @param {string} baseRef
 * @param {string} targetRef
 * @param {string} currentDir
 * @param {number} [seq]
 * @returns {Promise<DiffBundle>}
 */
declare function computeDiffBundleBetweenRefs(baseRef: string, targetRef: string, currentDir: string, seq?: number): Promise<DiffBundle>;
/**
 * @param {string} baseRef
 * @param {string} currentDir
 * @returns {Promise<DiffBundle>}
 */
declare function computeDiffBundle(baseRef: string, currentDir: string, seq?: number): Promise<DiffBundle>;
/**
 * @param {DiffBundle} bundle
 * @param {string} targetDir
 * @returns {Promise<void>}
 */
declare function applyDiffBundle(bundle: DiffBundle, targetDir: string): Promise<void>;
declare namespace __diffBundleInternals {
    export { extractPatchPath };
    export { readBinaryContentAtRef };
    export { splitGitDiff };
}
type DiffBundle = DiffBundle$1;
type FilePatch = FilePatch$1;
/**
 * @param {string} chunk
 * @returns {string}
 */
declare function extractPatchPath(chunk: string): string;
/**
 * @param {string} currentDir
 * @param {string} targetRef
 * @param {string} path
 * @returns {Promise<string | undefined>}
 */
declare function readBinaryContentAtRef(currentDir: string, targetRef: string, path: string): Promise<string | undefined>;
/**
 * @param {string} diff
 * @returns {string[]}
 */
declare function splitGitDiff(diff: string): string[];

type SignalResult$1 = {
    runId: string;
    signalName: string;
    delivered: boolean;
    status: "signalled" | "ignored";
};

type SignalPayload$1 = {
    runId: string;
    signalName: string;
    data?: unknown;
    correlationId?: string;
    sentBy?: string;
};

type RunStatusSchema$1 = "running" | "waiting-approval" | "waiting-event" | "waiting-timer" | "finished" | "continued" | "failed" | "cancelled";

type RunSummary$1 = {
    runId: string;
    parentRunId: string | null;
    workflowName: string;
    workflowPath: string | null;
    workflowHash: string | null;
    status: RunStatusSchema$1;
    createdAtMs: number;
    startedAtMs: number | null;
    finishedAtMs: number | null;
    heartbeatAtMs: number | null;
    runtimeOwnerId: string | null;
    cancelRequestedAtMs: number | null;
    hijackRequestedAtMs: number | null;
    hijackTarget: string | null;
    vcsType: string | null;
    vcsRoot: string | null;
    vcsRevision: string | null;
    errorJson: string | null;
    configJson: string | null;
};

type ListRunsPayload$1 = {
    limit?: number;
    status?: RunStatusSchema$1;
};

type GetRunResult$1 = RunSummary$1 | null;

type GetRunPayload$1 = {
    runId: string;
};

type CancelResult$1 = {
    runId: string;
    status: "cancelling" | "cancelled";
};

type CancelPayload$1 = {
    runId: string;
};

type ApprovalResult$1 = {
    runId: string;
    nodeId: string;
    iteration: number;
    approved: boolean;
};

type ApprovalPayload$1 = {
    runId: string;
    nodeId: string;
    iteration?: number;
    note?: string;
    decidedBy?: string;
};

type RunStatusSchema = RunStatusSchema$1;
declare const RunStatusSchema: Schema.Literal<["running", "waiting-approval", "waiting-event", "waiting-timer", "finished", "continued", "failed", "cancelled"]>;
declare const ApprovalPayloadSchema: Schema.Struct<{
    runId: typeof Schema.String;
    nodeId: typeof Schema.String;
    iteration: Schema.optional<typeof Schema.Number>;
    note: Schema.optional<typeof Schema.String>;
    decidedBy: Schema.optional<typeof Schema.String>;
}>;
declare const ApprovalResultSchema: Schema.Struct<{
    runId: typeof Schema.String;
    nodeId: typeof Schema.String;
    iteration: typeof Schema.Number;
    approved: typeof Schema.Boolean;
}>;
declare const CancelPayloadSchema: Schema.Struct<{
    runId: typeof Schema.String;
}>;
declare const CancelResultSchema: Schema.Struct<{
    runId: typeof Schema.String;
    status: Schema.Literal<["cancelling", "cancelled"]>;
}>;
declare const SignalPayloadSchema: Schema.Struct<{
    runId: typeof Schema.String;
    signalName: typeof Schema.String;
    data: Schema.optional<typeof Schema.Unknown>;
    correlationId: Schema.optional<typeof Schema.String>;
    sentBy: Schema.optional<typeof Schema.String>;
}>;
declare const SignalResultSchema: Schema.Struct<{
    runId: typeof Schema.String;
    signalName: typeof Schema.String;
    delivered: typeof Schema.Boolean;
    status: Schema.Literal<["signalled", "ignored"]>;
}>;
declare const ListRunsPayloadSchema: Schema.Struct<{
    limit: Schema.optional<typeof Schema.Number>;
    status: Schema.optional<Schema.Literal<["running", "waiting-approval", "waiting-event", "waiting-timer", "finished", "continued", "failed", "cancelled"]>>;
}>;
declare const RunSummarySchema: Schema.Struct<{
    runId: typeof Schema.String;
    parentRunId: Schema.NullOr<typeof Schema.String>;
    workflowName: typeof Schema.String;
    workflowPath: Schema.NullOr<typeof Schema.String>;
    workflowHash: Schema.NullOr<typeof Schema.String>;
    status: Schema.Literal<["running", "waiting-approval", "waiting-event", "waiting-timer", "finished", "continued", "failed", "cancelled"]>;
    createdAtMs: typeof Schema.Number;
    startedAtMs: Schema.NullOr<typeof Schema.Number>;
    finishedAtMs: Schema.NullOr<typeof Schema.Number>;
    heartbeatAtMs: Schema.NullOr<typeof Schema.Number>;
    runtimeOwnerId: Schema.NullOr<typeof Schema.String>;
    cancelRequestedAtMs: Schema.NullOr<typeof Schema.Number>;
    hijackRequestedAtMs: Schema.NullOr<typeof Schema.Number>;
    hijackTarget: Schema.NullOr<typeof Schema.String>;
    vcsType: Schema.NullOr<typeof Schema.String>;
    vcsRoot: Schema.NullOr<typeof Schema.String>;
    vcsRevision: Schema.NullOr<typeof Schema.String>;
    errorJson: Schema.NullOr<typeof Schema.String>;
    configJson: Schema.NullOr<typeof Schema.String>;
}>;
declare const GetRunPayloadSchema: Schema.Struct<{
    runId: typeof Schema.String;
}>;
declare const GetRunResultSchema: Schema.NullOr<Schema.Struct<{
    runId: typeof Schema.String;
    parentRunId: Schema.NullOr<typeof Schema.String>;
    workflowName: typeof Schema.String;
    workflowPath: Schema.NullOr<typeof Schema.String>;
    workflowHash: Schema.NullOr<typeof Schema.String>;
    status: Schema.Literal<["running", "waiting-approval", "waiting-event", "waiting-timer", "finished", "continued", "failed", "cancelled"]>;
    createdAtMs: typeof Schema.Number;
    startedAtMs: Schema.NullOr<typeof Schema.Number>;
    finishedAtMs: Schema.NullOr<typeof Schema.Number>;
    heartbeatAtMs: Schema.NullOr<typeof Schema.Number>;
    runtimeOwnerId: Schema.NullOr<typeof Schema.String>;
    cancelRequestedAtMs: Schema.NullOr<typeof Schema.Number>;
    hijackRequestedAtMs: Schema.NullOr<typeof Schema.Number>;
    hijackTarget: Schema.NullOr<typeof Schema.String>;
    vcsType: Schema.NullOr<typeof Schema.String>;
    vcsRoot: Schema.NullOr<typeof Schema.String>;
    vcsRevision: Schema.NullOr<typeof Schema.String>;
    errorJson: Schema.NullOr<typeof Schema.String>;
    configJson: Schema.NullOr<typeof Schema.String>;
}>>;
declare const approve: Rpc.Rpc<"approve", Schema.Struct<{
    runId: typeof Schema.String;
    nodeId: typeof Schema.String;
    iteration: Schema.optional<typeof Schema.Number>;
    note: Schema.optional<typeof Schema.String>;
    decidedBy: Schema.optional<typeof Schema.String>;
}>, Schema.Struct<{
    runId: typeof Schema.String;
    nodeId: typeof Schema.String;
    iteration: typeof Schema.Number;
    approved: typeof Schema.Boolean;
}>, typeof Schema.Never, never>;
declare const cancel: Rpc.Rpc<"cancel", Schema.Struct<{
    runId: typeof Schema.String;
}>, Schema.Struct<{
    runId: typeof Schema.String;
    status: Schema.Literal<["cancelling", "cancelled"]>;
}>, typeof Schema.Never, never>;
declare const signal: Rpc.Rpc<"signal", Schema.Struct<{
    runId: typeof Schema.String;
    signalName: typeof Schema.String;
    data: Schema.optional<typeof Schema.Unknown>;
    correlationId: Schema.optional<typeof Schema.String>;
    sentBy: Schema.optional<typeof Schema.String>;
}>, Schema.Struct<{
    runId: typeof Schema.String;
    signalName: typeof Schema.String;
    delivered: typeof Schema.Boolean;
    status: Schema.Literal<["signalled", "ignored"]>;
}>, typeof Schema.Never, never>;
declare const listRuns: Rpc.Rpc<"listRuns", Schema.Struct<{
    limit: Schema.optional<typeof Schema.Number>;
    status: Schema.optional<Schema.Literal<["running", "waiting-approval", "waiting-event", "waiting-timer", "finished", "continued", "failed", "cancelled"]>>;
}>, Schema.Array$<Schema.Struct<{
    runId: typeof Schema.String;
    parentRunId: Schema.NullOr<typeof Schema.String>;
    workflowName: typeof Schema.String;
    workflowPath: Schema.NullOr<typeof Schema.String>;
    workflowHash: Schema.NullOr<typeof Schema.String>;
    status: Schema.Literal<["running", "waiting-approval", "waiting-event", "waiting-timer", "finished", "continued", "failed", "cancelled"]>;
    createdAtMs: typeof Schema.Number;
    startedAtMs: Schema.NullOr<typeof Schema.Number>;
    finishedAtMs: Schema.NullOr<typeof Schema.Number>;
    heartbeatAtMs: Schema.NullOr<typeof Schema.Number>;
    runtimeOwnerId: Schema.NullOr<typeof Schema.String>;
    cancelRequestedAtMs: Schema.NullOr<typeof Schema.Number>;
    hijackRequestedAtMs: Schema.NullOr<typeof Schema.Number>;
    hijackTarget: Schema.NullOr<typeof Schema.String>;
    vcsType: Schema.NullOr<typeof Schema.String>;
    vcsRoot: Schema.NullOr<typeof Schema.String>;
    vcsRevision: Schema.NullOr<typeof Schema.String>;
    errorJson: Schema.NullOr<typeof Schema.String>;
    configJson: Schema.NullOr<typeof Schema.String>;
}>>, typeof Schema.Never, never>;
declare const getRun: Rpc.Rpc<"getRun", Schema.Struct<{
    runId: typeof Schema.String;
}>, Schema.NullOr<Schema.Struct<{
    runId: typeof Schema.String;
    parentRunId: Schema.NullOr<typeof Schema.String>;
    workflowName: typeof Schema.String;
    workflowPath: Schema.NullOr<typeof Schema.String>;
    workflowHash: Schema.NullOr<typeof Schema.String>;
    status: Schema.Literal<["running", "waiting-approval", "waiting-event", "waiting-timer", "finished", "continued", "failed", "cancelled"]>;
    createdAtMs: typeof Schema.Number;
    startedAtMs: Schema.NullOr<typeof Schema.Number>;
    finishedAtMs: Schema.NullOr<typeof Schema.Number>;
    heartbeatAtMs: Schema.NullOr<typeof Schema.Number>;
    runtimeOwnerId: Schema.NullOr<typeof Schema.String>;
    cancelRequestedAtMs: Schema.NullOr<typeof Schema.Number>;
    hijackRequestedAtMs: Schema.NullOr<typeof Schema.Number>;
    hijackTarget: Schema.NullOr<typeof Schema.String>;
    vcsType: Schema.NullOr<typeof Schema.String>;
    vcsRoot: Schema.NullOr<typeof Schema.String>;
    vcsRevision: Schema.NullOr<typeof Schema.String>;
    errorJson: Schema.NullOr<typeof Schema.String>;
    configJson: Schema.NullOr<typeof Schema.String>;
}>>, typeof Schema.Never, never>;
declare const SmithersRpcGroup: RpcGroup.RpcGroup<Rpc.Rpc<"approve", Schema.Struct<{
    runId: typeof Schema.String;
    nodeId: typeof Schema.String;
    iteration: Schema.optional<typeof Schema.Number>;
    note: Schema.optional<typeof Schema.String>;
    decidedBy: Schema.optional<typeof Schema.String>;
}>, Schema.Struct<{
    runId: typeof Schema.String;
    nodeId: typeof Schema.String;
    iteration: typeof Schema.Number;
    approved: typeof Schema.Boolean;
}>, typeof Schema.Never, never> | Rpc.Rpc<"cancel", Schema.Struct<{
    runId: typeof Schema.String;
}>, Schema.Struct<{
    runId: typeof Schema.String;
    status: Schema.Literal<["cancelling", "cancelled"]>;
}>, typeof Schema.Never, never> | Rpc.Rpc<"signal", Schema.Struct<{
    runId: typeof Schema.String;
    signalName: typeof Schema.String;
    data: Schema.optional<typeof Schema.Unknown>;
    correlationId: Schema.optional<typeof Schema.String>;
    sentBy: Schema.optional<typeof Schema.String>;
}>, Schema.Struct<{
    runId: typeof Schema.String;
    signalName: typeof Schema.String;
    delivered: typeof Schema.Boolean;
    status: Schema.Literal<["signalled", "ignored"]>;
}>, typeof Schema.Never, never> | Rpc.Rpc<"listRuns", Schema.Struct<{
    limit: Schema.optional<typeof Schema.Number>;
    status: Schema.optional<Schema.Literal<["running", "waiting-approval", "waiting-event", "waiting-timer", "finished", "continued", "failed", "cancelled"]>>;
}>, Schema.Array$<Schema.Struct<{
    runId: typeof Schema.String;
    parentRunId: Schema.NullOr<typeof Schema.String>;
    workflowName: typeof Schema.String;
    workflowPath: Schema.NullOr<typeof Schema.String>;
    workflowHash: Schema.NullOr<typeof Schema.String>;
    status: Schema.Literal<["running", "waiting-approval", "waiting-event", "waiting-timer", "finished", "continued", "failed", "cancelled"]>;
    createdAtMs: typeof Schema.Number;
    startedAtMs: Schema.NullOr<typeof Schema.Number>;
    finishedAtMs: Schema.NullOr<typeof Schema.Number>;
    heartbeatAtMs: Schema.NullOr<typeof Schema.Number>;
    runtimeOwnerId: Schema.NullOr<typeof Schema.String>;
    cancelRequestedAtMs: Schema.NullOr<typeof Schema.Number>;
    hijackRequestedAtMs: Schema.NullOr<typeof Schema.Number>;
    hijackTarget: Schema.NullOr<typeof Schema.String>;
    vcsType: Schema.NullOr<typeof Schema.String>;
    vcsRoot: Schema.NullOr<typeof Schema.String>;
    vcsRevision: Schema.NullOr<typeof Schema.String>;
    errorJson: Schema.NullOr<typeof Schema.String>;
    configJson: Schema.NullOr<typeof Schema.String>;
}>>, typeof Schema.Never, never> | Rpc.Rpc<"getRun", Schema.Struct<{
    runId: typeof Schema.String;
}>, Schema.NullOr<Schema.Struct<{
    runId: typeof Schema.String;
    parentRunId: Schema.NullOr<typeof Schema.String>;
    workflowName: typeof Schema.String;
    workflowPath: Schema.NullOr<typeof Schema.String>;
    workflowHash: Schema.NullOr<typeof Schema.String>;
    status: Schema.Literal<["running", "waiting-approval", "waiting-event", "waiting-timer", "finished", "continued", "failed", "cancelled"]>;
    createdAtMs: typeof Schema.Number;
    startedAtMs: Schema.NullOr<typeof Schema.Number>;
    finishedAtMs: Schema.NullOr<typeof Schema.Number>;
    heartbeatAtMs: Schema.NullOr<typeof Schema.Number>;
    runtimeOwnerId: Schema.NullOr<typeof Schema.String>;
    cancelRequestedAtMs: Schema.NullOr<typeof Schema.Number>;
    hijackRequestedAtMs: Schema.NullOr<typeof Schema.Number>;
    hijackTarget: Schema.NullOr<typeof Schema.String>;
    vcsType: Schema.NullOr<typeof Schema.String>;
    vcsRoot: Schema.NullOr<typeof Schema.String>;
    vcsRevision: Schema.NullOr<typeof Schema.String>;
    errorJson: Schema.NullOr<typeof Schema.String>;
    configJson: Schema.NullOr<typeof Schema.String>;
}>>, typeof Schema.Never, never>>;
type ApprovalPayload = ApprovalPayload$1;
type ApprovalResult = ApprovalResult$1;
type CancelPayload = CancelPayload$1;
type CancelResult = CancelResult$1;
type GetRunPayload = GetRunPayload$1;
type GetRunResult = GetRunResult$1;
type ListRunsPayload = ListRunsPayload$1;
type RunSummary = RunSummary$1;
type SignalPayload = SignalPayload$1;
type SignalResult = SignalResult$1;

declare function canExecuteBridgeManagedStaticTask(desc: _TaskDescriptor, cacheEnabled: boolean): boolean;
declare function executeStaticTaskBridge(adapter: _SmithersDb, runId: string, desc: _TaskDescriptor, eventBus: EventBus, toolConfig: StaticTaskBridgeToolConfig, workflowName: string, signal?: AbortSignal): Promise<void>;
declare namespace __staticTaskBridgeInternals {
    export { isAbortError };
}
type _SmithersDb = _smithers_orchestrator_db_adapter.SmithersDb;
type StaticTaskBridgeToolConfig = {
    rootDir: string;
};
type _TaskDescriptor = _smithers_orchestrator_graph_TaskDescriptor.TaskDescriptor;
/** @typedef {import("@smithers-orchestrator/db/adapter").SmithersDb} _SmithersDb */
/**
 * @typedef {{ rootDir: string; }} StaticTaskBridgeToolConfig
 */
/** @typedef {import("@smithers-orchestrator/graph/TaskDescriptor").TaskDescriptor} _TaskDescriptor */
/**
 * @param {unknown} err
 * @returns {boolean}
 */
declare function isAbortError(err: unknown): boolean;

type WorkflowPatchDecisions$1 = Record<string, boolean>;

type WorkflowVersioningRuntime$1 = {
    resolve(patchId: string): boolean;
    flush(): Promise<void>;
    snapshot(): WorkflowPatchDecisions$1;
};

type WorkflowPatchDecisionRecord$1 = {
    patchId: string;
    decision: boolean;
};

/**
 * @param {WorkflowVersioningRuntimeOptions} options
 * @returns {WorkflowVersioningRuntime}
 */
declare function createWorkflowVersioningRuntime(options: WorkflowVersioningRuntimeOptions): WorkflowVersioningRuntime;
/**
 * @template T
 * @param {WorkflowVersioningRuntime} runtime
 * @param {() => T} execute
 * @returns {T}
 */
declare function withWorkflowVersioningRuntime<T>(runtime: WorkflowVersioningRuntime, execute: () => T): T;
/**
 * @returns {| WorkflowVersioningRuntime | undefined}
 */
declare function getWorkflowVersioningRuntime(): WorkflowVersioningRuntime | undefined;
/**
 * @param {Record<string, unknown> | null | undefined} config
 * @returns {WorkflowPatchDecisions}
 */
declare function getWorkflowPatchDecisions(config: Record<string, unknown> | null | undefined): WorkflowPatchDecisions;
/**
 * @param {string} patchId
 * @returns {boolean}
 */
declare function usePatched(patchId: string): boolean;
type WorkflowPatchDecisionRecord = WorkflowPatchDecisionRecord$1;
type WorkflowPatchDecisions = WorkflowPatchDecisions$1;
type WorkflowVersioningRuntime = WorkflowVersioningRuntime$1;
type WorkflowVersioningRuntimeOptions = {
    baseConfig: Record<string, unknown>;
    initialDecisions?: WorkflowPatchDecisions;
    isNewRun: boolean;
    persist: (config: Record<string, unknown>) => Promise<void>;
    recordDecision?: (record: WorkflowPatchDecisionRecord) => Promise<void>;
};

/**
 * @param {string | null | undefined} path
 */
declare function loadOptimizationArtifact(path?: string | null | undefined): any;
/**
 * @param {import("@smithers-orchestrator/graph/TaskDescriptor").TaskDescriptor[]} tasks
 * @param {unknown} [artifact]
 */
declare function applyOptimizationArtifactToTasks(tasks: _smithers_orchestrator_graph_TaskDescriptor.TaskDescriptor[], artifact?: unknown): ({
    nodeId: string;
    ordinal: number;
    iteration: number;
    ralphId?: string;
    dependsOn?: string[];
    needs?: Record<string, string>;
    forkSource?: string;
    worktreeId?: string;
    worktreePath?: string;
    worktreeBranch?: string;
    worktreeBaseBranch?: string;
    outputTable: unknown | null;
    outputTableName: string;
    outputRef?: zod.ZodObject;
    outputSchema?: zod.ZodObject;
    parallelGroupId?: string;
    parallelMaxConcurrency?: number;
    needsApproval: boolean;
    waitAsync?: boolean;
    approvalMode?: "gate" | "decision" | "select" | "rank";
    approvalOnDeny?: "fail" | "continue" | "skip";
    approvalOptions?: {
        key: string;
        label: string;
        summary?: string;
        metadata?: Record<string, unknown>;
    }[];
    approvalAllowedScopes?: string[];
    approvalAllowedUsers?: string[];
    approvalAutoApprove?: {
        after?: number;
        audit?: boolean;
        conditionMet?: boolean;
        revertOnMet?: boolean;
    };
    skipIf: boolean;
    retries: number;
    retryPolicy?: {
        backoff?: "fixed" | "linear" | "exponential";
        initialDelayMs?: number;
    };
    timeoutMs: number | null;
    heartbeatTimeoutMs: number | null;
    continueOnFail: boolean;
    cachePolicy?: {
        [key: string]: unknown;
        by?: ((ctx: unknown) => unknown) | undefined;
        version?: string;
        key?: string;
        ttlMs?: number;
        scope?: "run" | "workflow" | "global";
    };
    hijack?: boolean;
    onHijackExit?: "complete" | "reopen";
    agent?: {
        id?: string;
        tools?: Record<string, unknown>;
        supportsNativeStructuredOutput?: boolean;
        capabilities?: {
            version: 1;
            engine: string;
            runtimeTools: Record<string, {
                description?: string;
                source?: string;
            }>;
            mcp: Record<string, unknown>;
            skills: Record<string, unknown>;
            humanInteraction: Record<string, unknown>;
            builtIns: string[];
        };
        generate: (args: unknown) => Promise<unknown>;
    } | {
        id?: string;
        tools?: Record<string, unknown>;
        supportsNativeStructuredOutput?: boolean;
        capabilities?: {
            version: 1;
            engine: string;
            runtimeTools: Record<string, {
                description?: string;
                source?: string;
            }>;
            mcp: Record<string, unknown>;
            skills: Record<string, unknown>;
            humanInteraction: Record<string, unknown>;
            builtIns: string[];
        };
        generate: (args: unknown) => Promise<unknown>;
    }[];
    prompt?: string;
    staticPayload?: unknown;
    computeFn?: () => unknown | Promise<unknown>;
    label?: string;
    meta?: Record<string, unknown>;
    scorers?: {
        [x: string]: unknown;
    };
    groundTruth?: unknown;
    context?: unknown;
    memoryConfig?: {
        recall?: {
            namespace?: {
                kind: "agent" | "workflow" | "global" | "user";
                id: string;
            };
            query?: string;
            topK?: number;
        };
        remember?: {
            namespace?: {
                kind: "agent" | "workflow" | "global" | "user";
                id: string;
            };
            key?: string;
        };
        threadId?: string;
    };
    aspects?: {
        tokenBudget?: {
            max: number;
            perTask?: number;
            onExceeded?: "fail" | "warn" | "skip-remaining";
        };
        latencySlo?: {
            maxMs: number;
            perTask?: number;
            onExceeded?: "fail" | "warn";
        };
    };
} | {
    prompt: string;
    meta: {
        optimizationArtifactId: any;
        optimizationStrategy: any;
    };
    nodeId: string;
    ordinal: number;
    iteration: number;
    ralphId?: string;
    dependsOn?: string[];
    needs?: Record<string, string>;
    forkSource?: string;
    worktreeId?: string;
    worktreePath?: string;
    worktreeBranch?: string;
    worktreeBaseBranch?: string;
    outputTable: unknown | null;
    outputTableName: string;
    outputRef?: zod.ZodObject;
    outputSchema?: zod.ZodObject;
    parallelGroupId?: string;
    parallelMaxConcurrency?: number;
    needsApproval: boolean;
    waitAsync?: boolean;
    approvalMode?: "gate" | "decision" | "select" | "rank";
    approvalOnDeny?: "fail" | "continue" | "skip";
    approvalOptions?: {
        key: string;
        label: string;
        summary?: string;
        metadata?: Record<string, unknown>;
    }[];
    approvalAllowedScopes?: string[];
    approvalAllowedUsers?: string[];
    approvalAutoApprove?: {
        after?: number;
        audit?: boolean;
        conditionMet?: boolean;
        revertOnMet?: boolean;
    };
    skipIf: boolean;
    retries: number;
    retryPolicy?: {
        backoff?: "fixed" | "linear" | "exponential";
        initialDelayMs?: number;
    };
    timeoutMs: number | null;
    heartbeatTimeoutMs: number | null;
    continueOnFail: boolean;
    cachePolicy?: {
        [key: string]: unknown;
        by?: ((ctx: unknown) => unknown) | undefined;
        version?: string;
        key?: string;
        ttlMs?: number;
        scope?: "run" | "workflow" | "global";
    };
    hijack?: boolean;
    onHijackExit?: "complete" | "reopen";
    agent?: {
        id?: string;
        tools?: Record<string, unknown>;
        supportsNativeStructuredOutput?: boolean;
        capabilities?: {
            version: 1;
            engine: string;
            runtimeTools: Record<string, {
                description?: string;
                source?: string;
            }>;
            mcp: Record<string, unknown>;
            skills: Record<string, unknown>;
            humanInteraction: Record<string, unknown>;
            builtIns: string[];
        };
        generate: (args: unknown) => Promise<unknown>;
    } | {
        id?: string;
        tools?: Record<string, unknown>;
        supportsNativeStructuredOutput?: boolean;
        capabilities?: {
            version: 1;
            engine: string;
            runtimeTools: Record<string, {
                description?: string;
                source?: string;
            }>;
            mcp: Record<string, unknown>;
            skills: Record<string, unknown>;
            humanInteraction: Record<string, unknown>;
            builtIns: string[];
        };
        generate: (args: unknown) => Promise<unknown>;
    }[];
    staticPayload?: unknown;
    computeFn?: () => unknown | Promise<unknown>;
    label?: string;
    scorers?: {
        [x: string]: unknown;
    };
    groundTruth?: unknown;
    context?: unknown;
    memoryConfig?: {
        recall?: {
            namespace?: {
                kind: "agent" | "workflow" | "global" | "user";
                id: string;
            };
            query?: string;
            topK?: number;
        };
        remember?: {
            namespace?: {
                kind: "agent" | "workflow" | "global" | "user";
                id: string;
            };
            key?: string;
        };
        threadId?: string;
    };
    aspects?: {
        tokenBudget?: {
            max: number;
            perTask?: number;
            onExceeded?: "fail" | "warn" | "skip-remaining";
        };
        latencySlo?: {
            maxMs: number;
            perTask?: number;
            onExceeded?: "fail" | "warn";
        };
    };
})[];
declare const OPTIMIZATION_ARTIFACT_ENV: "SMITHERS_OPTIMIZATION_ARTIFACT";

/**
 * @typedef {Record<string, any>} JsonSchema
 */
/**
 * Convert a JSON Schema to a Zod object schema.
 *
 * @param {JsonSchema} rootSchema
 * @returns {z.ZodObject<any>}
 */
declare function jsonSchemaToZod(rootSchema: JsonSchema): z.ZodObject<any>;
type JsonSchema = Record<string, any>;

type ChildWorkflowDefinition = ChildWorkflowDefinition$2;

export { type AlertHumanRequestOptions, AlertRuntime, type AlertRuntimeServices, type AnyEffect, type AnySchema, type ApprovalOptions, type ApprovalPayload, ApprovalPayloadSchema, type ApprovalResult, ApprovalResultSchema, type BridgeManagedTaskKind, type BuildAgentAskRequestInput, type BuilderApi, type BuilderNode, type BuilderStepContext, type BuilderStepHandle, type BuiltSmithersWorkflow, COMPLETED_ACTIVITY_RESULTS_MAX, type CancelPayload, CancelPayloadSchema, type CancelResult, CancelResultSchema, type ChildWorkflowDefinition, type ChildWorkflowExecuteOptions, type ComponentDefinition, type ComponentDefinitionBuilder, type ComputeTaskBridgeToolConfig, type ContinuationRequest, type CorrelatedSmithersEvent, type CorrelationContext, DEFAULT_AGENT_ASK_NODE_ID, type DiffBundle, EventBus$1 as EventBus, type ExecuteTaskActivityOptions, type FilePatch, type GetRunPayload, GetRunPayloadSchema, type GetRunResult, GetRunResultSchema, HUMAN_REQUEST_KINDS, HUMAN_REQUEST_STATUSES, type HijackState, type HotReloadEvent, HotWorkflowController, type HumanAnswerOutcome, type HumanRequestKind, type HumanRequestSchemaValidation, type HumanRequestStatus, type JsonSchema, type LegacyExecuteTaskFn, type ListRunsPayload, ListRunsPayloadSchema, OPTIMIZATION_ARTIFACT_ENV, type OverlayOptions, type PlanNode, type RalphMeta, type RalphState, type RalphStateMap, type ReadonlyTaskStateMap, RetriableTaskFailure, type RetryPolicy, type RetryWaitMap, type RunResult$2 as RunResult, RunStatusSchema, type RunSummary, RunSummarySchema, type SQLiteTable, type ScheduleResult, type ScheduleSnapshot, type SignalPayload, SignalPayloadSchema, type SignalResult, SignalResultSchema, type SignalRunOptions, Smithers, type SmithersAlertPolicy, type SmithersEvent, SmithersRpcGroup, type SmithersSqliteOptions, type StaticTaskBridgeToolConfig, type StepOptions, type TaskActivityContext, type TaskActivityRetryOptions, type TaskBridgeToolConfig, type TaskRecord, TaskResult, type TaskState, type TaskStateMap, TaskWorkerEntity, WatchTree, type WatchTreeOptions, WorkerDispatchKind, WorkerTask$1 as WorkerTask, WorkerTaskKind, type WorkflowDefinitionBuilder, type WorkflowGraph, type WorkflowPatchDecisionRecord, type WorkflowPatchDecisions, type WorkflowVersioningRuntime, type WorkflowVersioningRuntimeOptions, type XmlNode, type _TaskActivityContext, __approvalInternals, __builderInternals, __childWorkflowInternals, __computeTaskBridgeInternals, __diffBundleInternals, __humanRequestInternals, __staticTaskBridgeInternals, __workflowBridgeInternals, applyDiffBundle, applyOptimizationArtifactToTasks, approve, approveNode, awaitApprovalDurableDeferred, awaitWaitForEventDurableDeferred, bridgeApprovalResolve, bridgeSignalResolve, bridgeWaitForEventResolve, buildAgentAskRequestId, buildAgentAskRequestRow, buildHumanRequestId, buildOverlay, buildPlanTree, canExecuteBridgeManagedComputeTask, canExecuteBridgeManagedStaticTask, cancel, cancelPendingTimersBridge, cleanupGenerations, completedActivityResultsSize, computeDiffBundle, computeDiffBundleBetweenRefs, createDocWatcher, createSchedulerWakeQueue, createWorkflowVersioningRuntime, denyNode, dispatchWorkerTask, executeChildWorkflow, executeComputeTaskBridge, executeStaticTaskBridge, executeTaskActivity, executeTaskBridge, executeTaskBridgeEffect, fragment, getDefinedToolMetadata, getHumanTaskPrompt, getRun, getWorkflowMakeBridgeRuntime, getWorkflowPatchDecisions, getWorkflowVersioningRuntime, isBridgeManagedTimerTask, isBridgeManagedWaitForEventTask, isHumanRequestPastTimeout, isHumanTaskMeta, isPidAlive, isResolvedHumanRequestStatus, isRunHeartbeatFresh, isTaskResultFailure, jsonSchemaToZod, listRuns, loadOptimizationArtifact, makeAbortError, makeApprovalDurableDeferred, makeDurableDeferredBridgeExecutionId, makeTaskActivity, makeTaskBridgeKey, makeWaitForEventDurableDeferred, makeWorkerTask, parseAttemptMetaJson, parseRuntimeOwnerPid, renderFrame, resolveDeferredTaskStateBridge, resolveOverlayEntry, resolveSchema, runWorkflow, runWorkflowWithMakeBridge, scheduleTasks, signal, signalRun, startDocFileSync, subscribeTaskWorkerDispatches, syncDocsFromDisk, usePatched, validateHumanRequestValue, waitForHumanAnswer, wireAbortSignal, withWorkflowMakeBridgeRuntime, withWorkflowVersioningRuntime, workflow };
