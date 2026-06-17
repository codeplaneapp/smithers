import { Effect } from "effect";
import { SmithersError } from "@smithers-orchestrator/errors/SmithersError";
import { toSmithersError } from "@smithers-orchestrator/errors/toSmithersError";
import { buildPlanTree } from "./buildPlanTree.js";
import { buildStateKey } from "./buildStateKey.js";
import { cloneTaskStateMap } from "./cloneTaskStateMap.js";
import { computeRetryDelayMs } from "./computeRetryDelayMs.js";
import { parseStateKey } from "./parseStateKey.js";
import { scheduleTasks } from "./scheduleTasks.js";
/** @typedef {import("./ApprovalResolution.ts").ApprovalResolution} ApprovalResolution */
/** @typedef {import("./EngineDecision.ts").EngineDecision} EngineDecision */
/** @typedef {import("./RenderContext.ts").RenderContext} RenderContext */
/** @typedef {import("./RunResult.ts").RunResult} RunResult */
/** @typedef {import("./ScheduleResult.ts").ScheduleResult} ScheduleResult */
/** @typedef {import("./TaskOutput.ts").TaskOutput} TaskOutput */
/** @typedef {import("./WaitReason.ts").WaitReason} WaitReason */

/** @typedef {import("./WorkflowSessionOptions.ts").WorkflowSessionOptions} WorkflowSessionOptions */
/** @typedef {import("./WorkflowSessionService.ts").WorkflowSessionService} WorkflowSessionService */

/**
 * @returns {string}
 */
function defaultRunId() {
    return `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
}
/**
 * @param {readonly TaskDescriptor[]} tasks
 * @returns {Map<string, TaskDescriptor>}
 */
function descriptorMap(tasks) {
    const map = new Map();
    for (const task of tasks) {
        map.set(task.nodeId, task);
    }
    return map;
}
/**
 * @param {SessionState} state
 * @param {string} nodeId
 * @param {number} [iteration]
 * @returns {TaskDescriptor | undefined}
 */
function findDescriptor(state, nodeId, iteration) {
    const descriptor = state.descriptors.get(nodeId);
    if (descriptor && (iteration == null || descriptor.iteration === iteration)) {
        return descriptor;
    }
    return [...state.descriptors.values()].find((candidate) => candidate.nodeId === nodeId &&
        (iteration == null || candidate.iteration === iteration));
}
/**
 * @param {Pick<TaskDescriptor, "nodeId" | "iteration">} descriptor
 */
function stateKeyFor(descriptor) {
    return buildStateKey(descriptor.nodeId, descriptor.iteration);
}
/**
 * @param {WorkflowGraph} graph
 * @returns {string}
 */
function mountedSignature(graph) {
    return [...graph.mountedTaskIds].sort().join("\n");
}
/**
 * @param {SessionState} state
 * @param {number} [iterationOverride]
 * @returns {RenderContext}
 */
function renderContext(state, iterationOverride) {
    const ralphIterations = [...state.ralphState.values()].map((value) => value.iteration);
    return {
        runId: state.runId,
        graph: state.graph,
        iteration: iterationOverride ??
            (ralphIterations.length === 1 ? ralphIterations[0] : 0),
        taskStates: cloneTaskStateMap(state.states),
        outputs: new Map(state.outputs),
        ralphIterations: new Map([...state.ralphState.entries()].map(([id, value]) => [id, value.iteration])),
    };
}
/**
 * @param {SessionState} state
 * @param {number} currentTimeMs
 * @returns {WaitReason | undefined}
 */
function findWaitingReason(state, currentTimeMs) {
    for (const descriptor of state.descriptors.values()) {
        const taskState = state.states.get(stateKeyFor(descriptor));
        if (taskState === "waiting-approval") {
            return { _tag: "Approval", nodeId: descriptor.nodeId };
        }
        if (taskState === "waiting-event") {
            const eventName = typeof descriptor.meta?.__eventName === "string"
                ? descriptor.meta.__eventName
                : "";
            return { _tag: "Event", eventName };
        }
        if (taskState === "waiting-timer") {
            return {
                _tag: "Timer",
                resumeAtMs: timerResumeAtMs(descriptor, currentTimeMs),
            };
        }
    }
    return undefined;
}
/**
 * @param {TaskDescriptor} descriptor
 * @param {number} nowMs
 * @returns {number}
 */
function timerResumeAtMs(descriptor, nowMs) {
    const until = descriptor.meta?.__timerUntil;
    if (typeof until === "string" && until.length > 0) {
        const parsed = Date.parse(until);
        if (Number.isFinite(parsed))
            return parsed;
    }
    const duration = descriptor.meta?.__timerDuration;
    if (typeof duration === "string") {
        const ms = parseDurationMs(duration);
        if (ms != null)
            return nowMs + ms;
    }
    return nowMs;
}
/**
 * @param {string} value
 * @returns {number | null}
 */
function parseDurationMs(value) {
    const trimmed = value.trim();
    const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(trimmed);
    if (!match)
        return null;
    const amount = Number(match[1]);
    const unit = match[2] ?? "ms";
    if (!Number.isFinite(amount))
        return null;
    switch (unit) {
        case "h":
            return amount * 60 * 60 * 1000;
        case "m":
            return amount * 60 * 1000;
        case "s":
            return amount * 1000;
        case "ms":
        default:
            return amount;
    }
}
/**
 * @param {TaskDescriptor} descriptor
 * @param {unknown} error
 * @returns {boolean}
 */
function isRetryableFailure(descriptor, error) {
    const payloadCode = error && typeof error === "object" && typeof error.code === "string"
        ? error.code
        : undefined;
    const payloadDetails = error && typeof error === "object" && error.details && typeof error.details === "object"
        ? error.details
        : undefined;
    const normalized = toSmithersError(error);
    const code = payloadCode ?? normalized.code;
    const failureRetryable = payloadDetails?.failureRetryable ?? normalized.details?.failureRetryable;
    if (failureRetryable === false || code === "AGENT_CONFIG_INVALID") {
        return false;
    }
    const isAgentTask = Boolean(descriptor.agent);
    const nonRetryableComputeCodes = new Set([
        "INVALID_OUTPUT",
        "HEARTBEAT_PAYLOAD_NOT_JSON_SERIALIZABLE",
        "HEARTBEAT_PAYLOAD_TOO_LARGE",
    ]);
    if (!isAgentTask && nonRetryableComputeCodes.has(code)) {
        return false;
    }
    return true;
}
/**
 * @param {unknown} error
 * @returns {boolean}
 */
function isTransientSessionFailure(error) {
    const normalized = toSmithersError(error);
    const code = error && typeof error === "object" && typeof error.code === "string"
        ? error.code
        : normalized.code;
    return code === "SESSION_ERROR" ||
        code === "TASK_TIMEOUT" ||
        code === "TASK_HEARTBEAT_TIMEOUT" ||
        code === "TASK_ABORTED" ||
        normalized.details?.failureRetryable === true;
}
/**
 * Build a human-readable diagnostic for a dependency deadlock: pending tasks
 * that can never run because their `dependsOn` edges point at tasks missing from
 * the graph or themselves permanently blocked. The most common cause is a
 * `deps`/`needs` mismatch — a `deps={{ key: ... }}` whose key is not the upstream
 * task's id and was not remapped with `needs={{ key: '<id>' }}`, which the Task
 * component (deriveDepNodeIds) turns into a dependency on a non-existent node id.
 * @param {SessionState} state
 * @returns {string}
 */
function describeDeadlock(state) {
    const blocked = [];
    let sawMissing = false;
    for (const descriptor of state.descriptors.values()) {
        const taskState = state.states.get(stateKeyFor(descriptor)) ?? "pending";
        if (taskState !== "pending" && taskState !== "cancelled")
            continue;
        const unmet = [];
        for (const depId of descriptor.dependsOn ?? []) {
            const dep = state.descriptors.get(depId);
            if (!dep) {
                sawMissing = true;
                unmet.push(`'${depId}' (no such task)`);
            }
            else {
                const depState = state.states.get(stateKeyFor(dep)) ?? "pending";
                if (depState !== "finished" &&
                    depState !== "skipped" &&
                    !(depState === "failed" && dep.continueOnFail)) {
                    unmet.push(`'${depId}' (${depState})`);
                }
            }
        }
        if (unmet.length > 0) {
            blocked.push(`  - '${descriptor.nodeId}' is blocked on ${unmet.join(", ")}`);
        }
    }
    const lines = [
        "Workflow deadlocked: no task can run, and none is waiting on an approval, event, timer, or retry.",
    ];
    if (blocked.length > 0) {
        lines.push("Pending tasks and their unsatisfied dependencies:", ...blocked);
    }
    if (sawMissing) {
        lines.push("", "A dependency marked '(no such task)' references a node id that is not a mounted task. " +
            "If it came from deps={{ <key>: ... }}, the key is treated as the upstream task's id unless you remap it: " +
            "add needs={{ <key>: '<upstream task id>' }} (or rename the upstream task to match the key).");
    }
    return lines.join("\n");
}
/**
 * @param {unknown} error
 * @param {string} label
 * @returns {EngineDecision}
 */
function failedDecision(error, label) {
    return {
        _tag: "Failed",
        error: toSmithersError(error, label, { code: "SESSION_ERROR" }),
    };
}
/**
 * @param {WorkflowSessionOptions} [options]
 * @returns {WorkflowSessionService}
 */
export function makeWorkflowSession(options = {}) {
    const nowMs = options.nowMs ?? (() => Date.now());
    const state = {
        runId: options.runId ?? defaultRunId(),
        graph: null,
        plan: null,
        descriptors: new Map(),
        states: new Map(),
        outputs: new Map(),
        failures: new Map(),
        failureDescriptors: new Map(),
        retryCounts: new Map(),
        retryWait: new Map(),
        approvals: new Set(),
        ralphState: new Map(options.initialRalphState ?? []),
        schedule: null,
        cancelled: false,
        lastMountedSignature: null,
        lastDeadlockSignature: null,
    };
    /**
   * @param {Pick<TaskOutput, "nodeId" | "iteration">} output
   * @returns {string}
   */
    function outputKey(output) {
        return buildStateKey(output.nodeId, output.iteration);
    }
    /**
   * @param {RunResult["status"]} [status]
   * @returns {EngineDecision}
   */
    function finishedResult(status = "finished") {
        return {
            _tag: "Finished",
            result: {
                runId: state.runId,
                status,
                output: [...state.outputs.values()].at(-1)?.output,
            },
        };
    }
    /**
   * @returns {ScheduleResult}
   */
    function computeSchedule() {
        const result = scheduleTasks(state.plan, state.states, state.descriptors, state.ralphState, state.retryWait, nowMs());
        state.schedule = {
            plan: state.plan,
            result,
            computedAtMs: nowMs(),
        };
        return result;
    }
    /**
   * @param {WorkflowGraph} graph
   * @param {{ readonly pruneUnmounted?: boolean }} [opts]
   */
    function markGraph(graph, opts = {}) {
        state.graph = graph;
        state.descriptors = descriptorMap(graph.tasks);
        const { plan, ralphs } = buildPlanTree(graph.xml, state.ralphState);
        state.plan = plan;
        if (opts.pruneUnmounted) {
            const mounted = new Set(graph.mountedTaskIds);
            for (const [key, taskState] of state.states.entries()) {
                if (mounted.has(key))
                    continue;
                if (taskState === "in-progress") {
                    state.states.set(key, "cancelled");
                }
                else {
                    state.states.delete(key);
                }
                state.retryWait.delete(key);
                state.approvals.delete(key);
                state.retryCounts.delete(key);
                state.failureDescriptors.delete(key);
            }
        }
        for (const ralph of ralphs) {
            const existing = state.ralphState.get(ralph.id);
            if (ralph.until) {
                state.ralphState.set(ralph.id, {
                    iteration: existing?.iteration ?? 0,
                    done: true,
                });
            }
            else if (!existing) {
                state.ralphState.set(ralph.id, { iteration: 0, done: false });
            }
        }
        for (const task of graph.tasks) {
            const key = stateKeyFor(task);
            if (!state.states.has(key)) {
                state.states.set(key, "pending");
            }
        }
    }
    /**
   * @param {TaskOutput} output
   */
    function markTaskFinished(output) {
        const key = outputKey(output);
        state.states.set(key, "finished");
        state.outputs.set(key, output);
        state.retryWait.delete(key);
        state.failureDescriptors.delete(key);
    }
    /**
   * @param {number} [iteration]
   * @returns {EngineDecision}
   */
    function decideAfterOutputChange(iteration) {
        if (options.requireRerenderOnOutputChange) {
            return { _tag: "ReRender", context: renderContext(state, iteration) };
        }
        return decide();
    }
    /**
   * @param {TaskDescriptor} descriptor
   * @param {ApprovalResolution} resolution
   */
    function applyApprovalResolution(descriptor, resolution) {
        const key = stateKeyFor(descriptor);
        if (resolution.approved) {
            state.approvals.add(key);
            state.states.set(key, "pending");
        }
        else if (descriptor.approvalOnDeny === "skip") {
            state.states.set(key, "skipped");
        }
        else if (descriptor.approvalOnDeny === "continue") {
            state.states.set(key, "finished");
            state.outputs.set(key, {
                nodeId: descriptor.nodeId,
                iteration: descriptor.iteration,
                output: resolution,
            });
        }
        else {
            state.states.set(key, "failed");
            state.failures.set(key, resolution);
        }
    }
    /**
   * @param {string} eventName
   * @param {unknown} payload
   * @param {string | null} correlationId
   */
    function applyEventReceived(eventName, payload, correlationId) {
        for (const descriptor of state.descriptors.values()) {
            const key = stateKeyFor(descriptor);
            const taskState = state.states.get(key);
            const expected = typeof descriptor.meta?.__eventName === "string"
                ? descriptor.meta.__eventName
                : undefined;
            const expectedCorrelation = typeof descriptor.meta?.__correlationId === "string"
                ? descriptor.meta.__correlationId
                : undefined;
            if (taskState === "waiting-event" &&
                (!expected || expected === eventName) &&
                (expectedCorrelation === undefined || expectedCorrelation === correlationId)) {
                state.states.set(key, "finished");
                state.outputs.set(key, {
                    nodeId: descriptor.nodeId,
                    iteration: descriptor.iteration,
                    output: payload,
                });
            }
        }
    }
    /**
   * @param {TaskDescriptor} descriptor
   * @param {unknown} error
   * @returns {EngineDecision}
   */
    function applyFailure(descriptor, error) {
        const key = stateKeyFor(descriptor);
        const failureCount = (state.retryCounts.get(key) ?? 0) + 1;
        state.retryCounts.set(key, failureCount);
        const retryable = isRetryableFailure(descriptor, error);
        const canRetry = retryable &&
            (descriptor.retries === Infinity || failureCount <= descriptor.retries);
        if (canRetry) {
            const delay = computeRetryDelayMs(descriptor.retryPolicy, failureCount);
            state.states.set(key, "pending");
            if (delay > 0) {
                state.retryWait.set(key, nowMs() + delay);
            }
            else {
                state.retryWait.delete(key);
            }
            return decide();
        }
        state.states.set(key, "failed");
        state.failures.set(key, error);
        state.failureDescriptors.set(key, descriptor);
        return decide();
    }
    /**
   * @returns {EngineDecision | null}
   */
    function unhandledFailureDecision(recoveryKeys = new Set()) {
        for (const [key, taskState] of state.states) {
            const parsed = parseStateKey(key);
            const descriptor = findDescriptor(state, parsed.nodeId, parsed.iteration) ??
                state.failureDescriptors.get(key);
            if (taskState === "failed" && !descriptor?.continueOnFail) {
                if (recoveryKeys.has(key)) {
                    continue;
                }
                if (descriptor?.agent && isTransientSessionFailure(state.failures.get(key))) {
                    continue;
                }
                return {
                    _tag: "Failed",
                    error: new SmithersError("SESSION_ERROR", `Task failed: ${descriptor?.nodeId ?? key}`, { key }, state.failures.get(key)),
                };
            }
        }
        return null;
    }
    function ralphStatePayload() {
        return {
            ralphState: Object.fromEntries([...state.ralphState.entries()].map(([id, value]) => [
                id,
                { iteration: value.iteration, done: value.done },
            ])),
        };
    }
    /**
   * @returns {EngineDecision}
   */
    function decide(depth = 0) {
        if (depth > 10) {
            return {
                _tag: "Failed",
                error: new SmithersError("SCHEDULER_ERROR", "Exceeded scheduler decide() depth guard.", { depth }),
            };
        }
        if (state.cancelled) {
            return finishedResult("cancelled");
        }
        if (!state.graph) {
            return { _tag: "Wait", reason: { _tag: "ExternalTrigger" } };
        }
        const schedule = computeSchedule();
        if (schedule.fatalError) {
            return {
                _tag: "Failed",
                error: new SmithersError("SCHEDULER_ERROR", schedule.fatalError),
            };
        }
        if (schedule.continuation) {
            return {
                _tag: "ContinueAsNew",
                transition: {
                    reason: "explicit",
                    stateJson: schedule.continuation.stateJson,
                },
            };
        }
        const recoveryKeys = new Set(schedule.failureRecoveryKeys ?? []);
        let failure = unhandledFailureDecision(recoveryKeys);
        if (failure) {
            return failure;
        }
        const executable = [];
        let waitReason;
        let changed = false;
        for (const task of schedule.runnable) {
            const key = stateKeyFor(task);
            if (task.skipIf) {
                state.states.set(key, "skipped");
                changed = true;
                continue;
            }
            if (task.needsApproval && !state.approvals.has(key)) {
                state.states.set(key, "waiting-approval");
                changed = true;
                if (task.waitAsync) {
                    continue;
                }
                waitReason ??= { _tag: "Approval", nodeId: task.nodeId };
                continue;
            }
            if (task.meta?.__waitForEvent) {
                state.states.set(key, "waiting-event");
                changed = true;
                if (task.waitAsync) {
                    continue;
                }
                waitReason ??= {
                    _tag: "Event",
                    eventName: typeof task.meta.__eventName === "string" ? task.meta.__eventName : "",
                };
                continue;
            }
            if (task.meta?.__timer) {
                const resumeAtMs = timerResumeAtMs(task, nowMs());
                state.states.set(key, "waiting-timer");
                waitReason ??= { _tag: "Timer", resumeAtMs };
                changed = true;
                continue;
            }
            const budgetBreach = options.evaluateAspectBudget?.(task);
            if (budgetBreach) {
                if (budgetBreach.onExceeded === "skip-remaining") {
                    options.onAspectBudgetSkip?.(task, budgetBreach);
                    state.states.set(key, "skipped");
                    changed = true;
                    continue;
                }
                if (budgetBreach.onExceeded === "warn") {
                    options.onAspectBudgetWarn?.(task, budgetBreach);
                }
                else {
                    return {
                        _tag: "Failed",
                        error: new SmithersError("ASPECT_BUDGET_EXCEEDED", `Aspects ${budgetBreach.kind} budget exceeded for task "${task.nodeId}": ${budgetBreach.current} >= ${budgetBreach.limit}`, {
                            kind: budgetBreach.kind,
                            limit: budgetBreach.limit,
                            current: budgetBreach.current,
                        }),
                    };
                }
            }
            state.states.set(key, "in-progress");
            executable.push(task);
            changed = true;
        }
        if (executable.length > 0) {
            return { _tag: "Execute", tasks: executable };
        }
        if (waitReason) {
            return { _tag: "Wait", reason: waitReason };
        }
        if (changed) {
            return decide(depth + 1);
        }
        const existingWait = findWaitingReason(state, nowMs());
        if (existingWait) {
            return { _tag: "Wait", reason: existingWait };
        }
        if (schedule.readyRalphs.length > 0 && !unhandledFailureDecision(recoveryKeys)) {
            // A ralph is ready only when every task in its own subtree is
            // terminal, so pending or in-flight work elsewhere in the graph must
            // not starve its next iteration (#267). Run-level continue-as-new
            // handoffs stay quiescence-only: tearing down the run while sibling
            // tasks are mid-flight is not safe, so those ralphs are deferred.
            // An unhandled task failure keeps its precedence over further loop
            // iterations (decide() already returns it at the top; this guard
            // makes the ordering explicit).
            const hasInProgress = [...state.states.values()].some((taskState) => taskState === "in-progress");
            let advanced = false;
            for (const ralph of schedule.readyRalphs) {
                const current = state.ralphState.get(ralph.id) ?? {
                    iteration: 0,
                    done: false,
                };
                if (ralph.until) {
                    state.ralphState.set(ralph.id, { ...current, done: true });
                    advanced = true;
                    continue;
                }
                const nextIteration = current.iteration + 1;
                if (nextIteration >= ralph.maxIterations) {
                    if (ralph.onMaxReached === "fail") {
                        return {
                            _tag: "Failed",
                            error: new SmithersError("RALPH_MAX_REACHED", `Ralph ${ralph.id} reached maxIterations ${ralph.maxIterations}.`, { ralphId: ralph.id, maxIterations: ralph.maxIterations }),
                        };
                    }
                    state.ralphState.set(ralph.id, { iteration: current.iteration, done: true });
                    advanced = true;
                    continue;
                }
                const wantsContinueAsNew = ralph.continueAsNewEvery != null &&
                    ralph.continueAsNewEvery > 0 &&
                    nextIteration > 0 &&
                    nextIteration % ralph.continueAsNewEvery === 0;
                if (wantsContinueAsNew && (hasInProgress || schedule.pendingExists)) {
                    continue;
                }
                state.ralphState.set(ralph.id, { iteration: nextIteration, done: false });
                if (wantsContinueAsNew) {
                    return {
                        _tag: "ContinueAsNew",
                        transition: {
                            reason: "loop-threshold",
                            iteration: nextIteration,
                            statePayload: ralphStatePayload(),
                        },
                    };
                }
                advanced = true;
            }
            if (advanced) {
                return { _tag: "ReRender", context: renderContext(state) };
            }
        }
        if (schedule.pendingExists) {
            if (schedule.nextRetryAtMs != null) {
                return {
                    _tag: "Wait",
                    reason: {
                        _tag: "RetryBackoff",
                        waitMs: Math.max(0, schedule.nextRetryAtMs - nowMs()),
                    },
                };
            }
            // Nothing is runnable, in flight, or waiting on an approval, event, or
            // timer, yet tasks remain pending. They are blocked on dependencies
            // nothing will ever satisfy — most often a deps/needs key that maps to
            // a node id no task produces, which becomes a dependsOn on a missing
            // node. Returning Wait here suspends the run forever with no error.
            // Give a reactive re-render one chance to mount a producer (the mounted
            // signature changes), then fail loudly with a diagnostic.
            const noInProgress = ![...state.states.values()].some((taskState) => taskState === "in-progress");
            if (noInProgress) {
                if (options.requireStableFinish && state.graph) {
                    const signature = mountedSignature(state.graph);
                    if (state.lastDeadlockSignature !== signature) {
                        state.lastDeadlockSignature = signature;
                        return { _tag: "ReRender", context: renderContext(state) };
                    }
                }
                return {
                    _tag: "Failed",
                    error: new SmithersError("DEPENDENCY_DEADLOCK", describeDeadlock(state)),
                };
            }
            return { _tag: "Wait", reason: { _tag: "ExternalTrigger" } };
        }
        if ([...state.states.values()].some((taskState) => taskState === "in-progress")) {
            return { _tag: "Wait", reason: { _tag: "ExternalTrigger" } };
        }
        failure = unhandledFailureDecision(recoveryKeys);
        if (failure) {
            return failure;
        }
        if (options.requireStableFinish && state.graph) {
            const signature = mountedSignature(state.graph);
            if (state.lastMountedSignature !== signature) {
                state.lastMountedSignature = signature;
                return { _tag: "ReRender", context: renderContext(state) };
            }
        }
        return finishedResult();
    }
    return {
        submitGraph: (graph) => Effect.sync(() => {
            try {
                markGraph(graph);
                return decide();
            }
            catch (error) {
                return failedDecision(error, "submitGraph");
            }
        }),
        taskCompleted: (output) => Effect.sync(() => {
            const descriptor = findDescriptor(state, output.nodeId, output.iteration);
            if (!descriptor) {
                return failedDecision(new SmithersError("NODE_NOT_FOUND", `Unknown task ${output.nodeId}`), "taskCompleted");
            }
            markTaskFinished(output);
            return decideAfterOutputChange(output.iteration);
        }),
        taskFailed: (failure) => Effect.sync(() => {
            const descriptor = findDescriptor(state, failure.nodeId, failure.iteration);
            if (!descriptor) {
                return failedDecision(new SmithersError("NODE_NOT_FOUND", `Unknown task ${failure.nodeId}`), "taskFailed");
            }
            return applyFailure(descriptor, failure.error);
        }),
        approvalResolved: (nodeId, resolution) => Effect.sync(() => {
            const descriptor = findDescriptor(state, nodeId);
            if (!descriptor) {
                return failedDecision(new SmithersError("NODE_NOT_FOUND", `Unknown approval task ${nodeId}`), "approvalResolved");
            }
            applyApprovalResolution(descriptor, resolution);
            return decide();
        }),
        approvalTimedOut: (nodeId) => Effect.sync(() => {
            const descriptor = findDescriptor(state, nodeId);
            if (!descriptor) {
                return failedDecision(new SmithersError("NODE_NOT_FOUND", `Unknown approval task ${nodeId}`), "approvalTimedOut");
            }
            const key = stateKeyFor(descriptor);
            if (state.states.get(key) !== "waiting-approval") {
                return decide();
            }
            applyApprovalResolution(descriptor, {
                approved: false,
                note: "approval timed out",
            });
            if (state.states.get(key) === "failed") {
                state.failures.set(key, new SmithersError("TASK_TIMEOUT", `Approval timed out for ${descriptor.nodeId}`, { nodeId: descriptor.nodeId, iteration: descriptor.iteration }));
            }
            return decide();
        }),
        eventReceived: (eventName, payload, correlationId = null) => Effect.sync(() => {
            applyEventReceived(eventName, payload, correlationId);
            return decide();
        }),
        signalReceived: (signalName, payload, correlationId = null) => Effect.sync(() => {
            applyEventReceived(signalName, payload, correlationId);
            return decide();
        }),
        timerFired: (nodeId, firedAtMs = nowMs()) => Effect.sync(() => {
            const descriptor = findDescriptor(state, nodeId);
            if (!descriptor) {
                return failedDecision(new SmithersError("NODE_NOT_FOUND", `Unknown timer task ${nodeId}`), "timerFired");
            }
            const key = stateKeyFor(descriptor);
            if (state.states.get(key) !== "waiting-timer" && !descriptor.meta?.__timer) {
                return decide();
            }
            markTaskFinished({
                nodeId: descriptor.nodeId,
                iteration: descriptor.iteration,
                output: { firedAtMs },
            });
            return decideAfterOutputChange(descriptor.iteration);
        }),
        hotReloaded: (graph) => Effect.sync(() => {
            try {
                markGraph(graph, { pruneUnmounted: true });
                state.lastMountedSignature = null;
                return decide();
            }
            catch (error) {
                return failedDecision(error, "hotReloaded");
            }
        }),
        heartbeatTimedOut: (nodeId, iteration, details = {}) => Effect.sync(() => {
            const descriptor = findDescriptor(state, nodeId, iteration);
            if (!descriptor) {
                return failedDecision(new SmithersError("NODE_NOT_FOUND", `Unknown task ${nodeId}`), "heartbeatTimedOut");
            }
            return applyFailure(descriptor, new SmithersError("TASK_HEARTBEAT_TIMEOUT", `Task ${descriptor.nodeId} heartbeat timed out.`, {
                nodeId: descriptor.nodeId,
                iteration: descriptor.iteration,
                timeoutMs: descriptor.heartbeatTimeoutMs,
                ...details,
            }));
        }),
        cacheResolved: (output, _cached) => Effect.sync(() => {
            const descriptor = findDescriptor(state, output.nodeId, output.iteration);
            if (!descriptor) {
                return failedDecision(new SmithersError("NODE_NOT_FOUND", `Unknown cached task ${output.nodeId}`), "cacheResolved");
            }
            markTaskFinished({
                ...output,
                usage: output.usage ?? null,
                output: output.output,
            });
            return decideAfterOutputChange(output.iteration);
        }),
        cacheMissed: (nodeId, iteration) => Effect.sync(() => {
            const descriptor = findDescriptor(state, nodeId, iteration);
            if (!descriptor) {
                return failedDecision(new SmithersError("NODE_NOT_FOUND", `Unknown cached task ${nodeId}`), "cacheMissed");
            }
            state.retryWait.delete(stateKeyFor(descriptor));
            return decide();
        }),
        recoverOrphanedTasks: () => Effect.sync(() => {
            let count = 0;
            for (const [key, taskState] of state.states) {
                if (taskState === "in-progress") {
                    state.states.set(key, "pending");
                    count += 1;
                }
            }
            const decision = decide();
            if (count > 0 || decision._tag !== "Wait") {
                return decision;
            }
            return { _tag: "Wait", reason: { _tag: "OrphanRecovery", count } };
        }),
        cancelRequested: () => Effect.sync(() => {
            state.cancelled = true;
            for (const [key, taskState] of state.states) {
                if (taskState !== "finished" && taskState !== "failed" && taskState !== "skipped") {
                    state.states.set(key, "cancelled");
                }
            }
            return finishedResult("cancelled");
        }),
        getTaskStates: () => Effect.sync(() => cloneTaskStateMap(state.states)),
        getSchedule: () => Effect.sync(() => state.schedule),
        getCurrentGraph: () => Effect.sync(() => state.graph),
    };
}
