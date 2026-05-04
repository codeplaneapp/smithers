import { buildStateKey } from "./buildStateKey.js";
/** @typedef {import("./TaskState.ts").TaskState} TaskState */

/** @typedef {import("./PlanNode.ts").PlanNode} PlanNode */
/** @typedef {import("./RalphStateMap.ts").RalphStateMap} RalphStateMap */
/** @typedef {import("./RetryWaitMap.ts").RetryWaitMap} RetryWaitMap */
/** @typedef {import("./ScheduleResult.ts").ScheduleResult} ScheduleResult */
/** @typedef {import("@smithers-orchestrator/graph").TaskDescriptor} TaskDescriptor */
/** @typedef {import("./TaskStateMap.ts").TaskStateMap} TaskStateMap */

/**
 * @param {TaskState} state
 * @param {TaskDescriptor} descriptor
 * @returns {boolean}
 */
function isTerminal(state, descriptor) {
    if (state === "finished" || state === "skipped")
        return true;
    if (state === "failed")
        return descriptor.continueOnFail;
    return false;
}
/**
 * @param {TaskState} state
 * @param {TaskDescriptor} descriptor
 * @returns {boolean}
 */
function isTraversalTerminal(state, descriptor) {
    if (isTerminal(state, descriptor))
        return true;
    return Boolean(descriptor.waitAsync &&
        (state === "waiting-approval" || state === "waiting-event"));
}
/**
 * @param {TaskDescriptor} descriptor
 * @param {TaskStateMap} states
 * @param {Map<string, TaskDescriptor>} descriptors
 * @returns {boolean}
 */
function dependenciesSatisfied(descriptor, states, descriptors) {
    if (!descriptor.dependsOn || descriptor.dependsOn.length === 0)
        return true;
    for (const dependencyId of descriptor.dependsOn) {
        const dependency = descriptors.get(dependencyId);
        if (!dependency)
            return false;
        const state = states.get(buildStateKey(dependency.nodeId, dependency.iteration));
        if (!state || !isTerminal(state, dependency)) {
            return false;
        }
    }
    return true;
}
/**
 * @param {PlanNode | null} plan
 * @param {TaskStateMap} states
 * @param {Map<string, TaskDescriptor>} descriptors
 * @param {RalphStateMap} ralphState
 * @param {RetryWaitMap} retryWait
 * @param {number} nowMs
 * @returns {ScheduleResult}
 */
export function scheduleTasks(plan, states, descriptors, ralphState, retryWait, nowMs) {
    const runnable = [];
    let pendingExists = false;
    let waitingApprovalExists = false;
    let waitingEventExists = false;
    let waitingTimerExists = false;
    const readyRalphs = [];
    let continuation;
    let nextRetryAtMs;
    let fatalError;
    let failureRecoveryActive = false;
    const failureRecoveryKeys = new Set();
    const groupUsage = new Map();
    for (const [stateKey, state] of states) {
        if (state !== "in-progress")
            continue;
        const separator = stateKey.lastIndexOf("::");
        const nodeId = separator >= 0 ? stateKey.slice(0, separator) : stateKey;
        const descriptor = descriptors.get(nodeId);
        if (!descriptor)
            continue;
        const groupId = descriptor.parallelGroupId;
        const cap = descriptor.parallelMaxConcurrency;
        if (groupId && cap != null) {
            groupUsage.set(groupId, (groupUsage.get(groupId) ?? 0) + 1);
        }
    }
    /**
   * @param {PlanNode} node
   * @returns {{ readonly terminal: boolean; readonly failed: boolean }}
   */
    function inspect(node, options = {}) {
        switch (node.kind) {
            case "task": {
                const descriptor = descriptors.get(node.nodeId);
                if (!descriptor)
                    return { terminal: true, failed: false };
                const state = states.get(buildStateKey(descriptor.nodeId, descriptor.iteration)) ??
                    "pending";
                const terminal = state === "finished" ||
                    state === "skipped" ||
                    state === "failed" ||
                    Boolean(descriptor.waitAsync &&
                        (state === "waiting-approval" || state === "waiting-event"));
                return {
                    terminal,
                    failed: state === "failed" &&
                        (options.includeContinuedFailures || !descriptor.continueOnFail),
                };
            }
            case "sequence":
            case "group": {
                for (const child of node.children) {
                    const result = inspect(child, options);
                    if (!result.terminal)
                        return { terminal: false, failed: false };
                    if (result.failed)
                        return { terminal: true, failed: true };
                }
                return { terminal: true, failed: false };
            }
            case "parallel": {
                let terminal = true;
                let failed = false;
                for (const child of node.children) {
                    const result = inspect(child, options);
                    if (!result.terminal)
                        terminal = false;
                    if (result.failed)
                        failed = true;
                }
                return { terminal, failed: terminal && failed };
            }
            case "saga": {
                let completedActions = 0;
                let failed = false;
                for (const child of node.actionChildren) {
                    const result = inspect(child, {
                        includeContinuedFailures: true,
                    });
                    if (!result.terminal)
                        return { terminal: false, failed: false };
                    if (result.failed) {
                        failed = true;
                        break;
                    }
                    completedActions += 1;
                }
                if (!failed)
                    return { terminal: true, failed: false };
                if (node.onFailure === "fail")
                    return { terminal: true, failed: true };
                let compensationFailed = false;
                for (let index = completedActions - 1; index >= 0; index -= 1) {
                    const compensation = node.compensationChildren[index];
                    if (!compensation)
                        continue;
                    const result = inspect(compensation, options);
                    if (!result.terminal)
                        return { terminal: false, failed: false };
                    if (result.failed)
                        compensationFailed = true;
                }
                return {
                    terminal: true,
                    failed: compensationFailed || node.onFailure === "compensate-and-fail",
                };
            }
            case "try-catch-finally": {
                let tryFailed = false;
                for (const child of node.tryChildren) {
                    const result = inspect(child, {
                        includeContinuedFailures: true,
                    });
                    if (!result.terminal)
                        return { terminal: false, failed: false };
                    if (result.failed) {
                        tryFailed = true;
                        break;
                    }
                }
                if (!tryFailed) {
                    return inspect({
                        kind: "sequence",
                        children: node.finallyChildren,
                    }, options);
                }
                let catchFailed = node.catchChildren.length === 0;
                if (node.catchChildren.length > 0) {
                    const catchStatus = inspect({
                        kind: "sequence",
                        children: node.catchChildren,
                    }, options);
                    if (!catchStatus.terminal)
                        return { terminal: false, failed: false };
                    catchFailed = catchStatus.failed;
                }
                const finallyStatus = inspect({
                    kind: "sequence",
                    children: node.finallyChildren,
                }, options);
                if (!finallyStatus.terminal)
                    return { terminal: false, failed: false };
                return {
                    terminal: true,
                    failed: catchFailed || finallyStatus.failed,
                };
            }
            default:
                return { terminal: true, failed: false };
        }
    }
    /**
   * @param {PlanNode} node
   * @param {{ includeContinuedFailures?: boolean }} options
   */
    function collectFailureKeys(node, options = {}) {
        switch (node.kind) {
            case "task": {
                const descriptor = descriptors.get(node.nodeId);
                if (!descriptor)
                    return;
                const key = buildStateKey(descriptor.nodeId, descriptor.iteration);
                const state = states.get(key) ?? "pending";
                if (state === "failed" &&
                    (options.includeContinuedFailures || !descriptor.continueOnFail)) {
                    failureRecoveryKeys.add(key);
                }
                return;
            }
            case "sequence":
            case "group":
            case "parallel":
                for (const child of node.children) {
                    collectFailureKeys(child, options);
                }
                return;
            case "saga":
                for (const child of node.actionChildren) {
                    collectFailureKeys(child, options);
                }
                return;
            case "try-catch-finally":
                for (const child of node.tryChildren) {
                    collectFailureKeys(child, options);
                }
                for (const child of node.catchChildren) {
                    collectFailureKeys(child, options);
                }
                for (const child of node.finallyChildren) {
                    collectFailureKeys(child, options);
                }
                return;
        }
    }
    /**
   * @param {readonly PlanNode[]} children
   * @param {{ includeContinuedFailures?: boolean }} options
   */
    function collectChildFailureKeys(children, options = {}) {
        for (const child of children) {
            collectFailureKeys(child, options);
        }
    }
    /**
   * @param {readonly PlanNode[]} children
   */
    function walkSequence(children) {
        for (const child of children) {
            const result = walk(child);
            if (!result.terminal)
                return { terminal: false };
        }
        return { terminal: true };
    }
    /**
   * @param {PlanNode} node
   * @returns {{ readonly terminal: boolean }}
   */
    function walk(node) {
        switch (node.kind) {
            case "task": {
                const descriptor = descriptors.get(node.nodeId);
                if (!descriptor)
                    return { terminal: true };
                const state = states.get(buildStateKey(descriptor.nodeId, descriptor.iteration)) ??
                    "pending";
                if (state === "waiting-approval")
                    waitingApprovalExists = true;
                if (state === "waiting-event")
                    waitingEventExists = true;
                if (state === "waiting-timer")
                    waitingTimerExists = true;
                if (state === "pending" || state === "cancelled")
                    pendingExists = true;
                const terminal = isTraversalTerminal(state, descriptor);
                if (!terminal && (state === "pending" || state === "cancelled")) {
                    if (!dependenciesSatisfied(descriptor, states, descriptors)) {
                        return { terminal };
                    }
                    const retryAt = retryWait.get(buildStateKey(descriptor.nodeId, descriptor.iteration));
                    if (retryAt && retryAt > nowMs) {
                        pendingExists = true;
                        nextRetryAtMs =
                            nextRetryAtMs == null ? retryAt : Math.min(nextRetryAtMs, retryAt);
                        return { terminal };
                    }
                    const groupId = descriptor.parallelGroupId;
                    const cap = descriptor.parallelMaxConcurrency;
                    if (groupId && cap != null) {
                        const used = groupUsage.get(groupId) ?? 0;
                        if (used >= cap) {
                            return { terminal };
                        }
                        groupUsage.set(groupId, used + 1);
                    }
                    runnable.push(descriptor);
                }
                return { terminal };
            }
            case "sequence":
                return walkSequence(node.children);
            case "parallel": {
                let terminal = true;
                for (const child of node.children) {
                    const result = walk(child);
                    if (!result.terminal)
                        terminal = false;
                }
                return { terminal };
            }
            case "ralph": {
                const state = ralphState.get(node.id);
                const done = node.until || state?.done;
                if (done)
                    return { terminal: true };
                let terminal = true;
                for (const child of node.children) {
                    const result = walk(child);
                    if (!result.terminal)
                        terminal = false;
                }
                if (terminal) {
                    readyRalphs.push({
                        id: node.id,
                        until: node.until,
                        maxIterations: node.maxIterations,
                        onMaxReached: node.onMaxReached,
                        continueAsNewEvery: node.continueAsNewEvery,
                    });
                }
                return { terminal: false };
            }
            case "continue-as-new":
                continuation = { stateJson: node.stateJson };
                return { terminal: false };
            case "saga": {
                let completedActions = 0;
                let failed = false;
                for (const child of node.actionChildren) {
                    const status = inspect(child, {
                        includeContinuedFailures: true,
                    });
                    if (!status.terminal)
                        return walk(child);
                    if (status.failed) {
                        failed = true;
                        break;
                    }
                    completedActions += 1;
                }
                if (!failed)
                    return { terminal: true };
                if (node.onFailure === "fail") {
                    fatalError ??= `Saga ${node.id} failed`;
                    return { terminal: true };
                }
                collectChildFailureKeys(node.actionChildren, {
                    includeContinuedFailures: true,
                });
                let compensationFailed = false;
                for (let index = completedActions - 1; index >= 0; index -= 1) {
                    const compensation = node.compensationChildren[index];
                    if (!compensation)
                        continue;
                    if (inspect(compensation).failed) {
                        compensationFailed = true;
                        break;
                    }
                }
                if (compensationFailed) {
                    return { terminal: false };
                }
                failureRecoveryActive = true;
                for (let index = completedActions - 1; index >= 0; index -= 1) {
                    const compensation = node.compensationChildren[index];
                    if (!compensation)
                        continue;
                    const result = walk(compensation);
                    if (!result.terminal)
                        return { terminal: false };
                }
                if (node.onFailure === "compensate-and-fail") {
                    fatalError ??= `Saga ${node.id} failed`;
                }
                return { terminal: true };
            }
            case "try-catch-finally": {
                let tryFailed = false;
                for (const child of node.tryChildren) {
                    const status = inspect(child, {
                        includeContinuedFailures: true,
                    });
                    if (!status.terminal)
                        return walk(child);
                    if (status.failed) {
                        tryFailed = true;
                        break;
                    }
                }
                if (tryFailed && node.catchChildren.length > 0) {
                    const collectTryFailureKeys = () => collectChildFailureKeys(node.tryChildren, {
                        includeContinuedFailures: true,
                    });
                    let catchFailed = false;
                    collectTryFailureKeys();
                    const catchStatus = inspect({
                        kind: "sequence",
                        children: node.catchChildren,
                    });
                    failureRecoveryActive = true;
                    catchFailed = catchStatus.failed;
                    if (!catchStatus.terminal) {
                        const catchResult = walkSequence(node.catchChildren);
                        if (!catchResult.terminal)
                            return catchResult;
                    }
                    const finallyStatus = inspect({
                        kind: "sequence",
                        children: node.finallyChildren,
                    });
                    if (finallyStatus.failed) {
                        collectTryFailureKeys();
                        failureRecoveryActive = false;
                        return { terminal: false };
                    }
                    const finallyResult = walkSequence(node.finallyChildren);
                    if (!finallyResult.terminal) {
                        collectTryFailureKeys();
                        if (catchFailed) {
                            collectChildFailureKeys(node.catchChildren);
                        }
                        failureRecoveryActive = true;
                        return finallyResult;
                    }
                    if (catchFailed) {
                        return { terminal: true };
                    }
                    return { terminal: true };
                }
                const finallyStatus = inspect({
                    kind: "sequence",
                    children: node.finallyChildren,
                });
                if (finallyStatus.failed) {
                    if (tryFailed) {
                        collectChildFailureKeys(node.tryChildren, {
                            includeContinuedFailures: true,
                        });
                    }
                    failureRecoveryActive = false;
                    return { terminal: false };
                }
                const finallyResult = walkSequence(node.finallyChildren);
                if (!finallyResult.terminal) {
                    if (tryFailed && node.catchChildren.length === 0) {
                        collectChildFailureKeys(node.tryChildren, {
                            includeContinuedFailures: true,
                        });
                        failureRecoveryActive = true;
                    }
                    return finallyResult;
                }
                if (tryFailed && node.catchChildren.length === 0) {
                    fatalError ??= `TryCatchFinally ${node.id} failed`;
                }
                return { terminal: true };
            }
            case "group": {
                let terminal = true;
                for (const child of node.children) {
                    const result = walk(child);
                    if (!result.terminal)
                        terminal = false;
                }
                return { terminal };
            }
            default:
                return { terminal: true };
        }
    }
    if (plan)
        walk(plan);
    return {
        runnable,
        pendingExists,
        waitingApprovalExists,
        waitingEventExists,
        waitingTimerExists,
        readyRalphs,
        continuation,
        nextRetryAtMs,
        fatalError,
        failureRecoveryActive,
        failureRecoveryKeys: [...failureRecoveryKeys],
    };
}
