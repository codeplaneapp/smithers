import { buildStateKey } from "./buildStateKey.js";
import { isTerminalState } from "./isTerminalState.js";
import { parseStateKey } from "./parseStateKey.js";
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
function isTraversalTerminal(state, descriptor) {
    if (isTerminalState(state, descriptor))
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
    for (const dependencyId of descriptor.dependsOn ?? []) {
        const dependency = descriptors.get(dependencyId);
        if (!dependency)
            return false;
        const state = states.get(buildStateKey(dependency.nodeId, dependency.iteration));
        if (!state || !isTerminalState(state, dependency)) {
            return false;
        }
    }
    // A forked task waits until its source task has a completed (terminal)
    // execution. The source is matched by logical id so a source inside a loop
    // is satisfied by whichever iteration has completed; the executor then
    // forks the latest completed snapshot for that id.
    if (descriptor.forkSource && !forkSourceTerminal(descriptor.forkSource, states, descriptors)) {
        return false;
    }
    return true;
}
/**
 * Strip the loop-scope suffix (`@@ralph=0,...`) from a node id to recover the
 * logical task id authored in JSX.
 * @param {string} nodeId
 * @returns {string}
 */
function logicalNodeId(nodeId) {
    const atIdx = nodeId.indexOf("@@");
    return atIdx === -1 ? nodeId : nodeId.slice(0, atIdx);
}
/**
 * Whether any execution of the fork source task (matched by logical id) has
 * reached a terminal state.
 * @param {string} forkSource
 * @param {TaskStateMap} states
 * @param {Map<string, TaskDescriptor>} descriptors
 * @returns {boolean}
 */
function forkSourceTerminal(forkSource, states, descriptors) {
    for (const descriptor of descriptors.values()) {
        if (logicalNodeId(descriptor.nodeId) !== forkSource)
            continue;
        const state = states.get(buildStateKey(descriptor.nodeId, descriptor.iteration));
        if (state && isTerminalState(state, descriptor)) {
            return true;
        }
    }
    return false;
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
        const { nodeId } = parseStateKey(stateKey);
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
   * @param {{ includeContinuedFailures?: boolean }} [options]
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
            case "ralph": {
                const state = ralphState.get(node.id);
                const done = node.until || state?.done;
                if (!done)
                    return { terminal: false, failed: false };
                for (const child of node.children) {
                    const result = inspect(child, options);
                    if (!result.terminal)
                        return { terminal: false, failed: false };
                    if (result.failed)
                        return { terminal: true, failed: true };
                }
                return { terminal: true, failed: false };
            }
            case "continue-as-new":
                return { terminal: false, failed: false };
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
            case "ralph":
                for (const child of node.children) {
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
                    if (!status.terminal) {
                        // A failure already present in this still-running action
                        // subtree (e.g. a failed task in a <Parallel> whose sibling
                        // is still in flight) must be recorded as recoverable now.
                        // Otherwise decide()'s unhandled-failure check fails the run
                        // before the action region settles and the saga's
                        // compensation can run — an order-dependent bug that only
                        // bites when the failing task settles before its sibling.
                        const before = failureRecoveryKeys.size;
                        collectFailureKeys(child, { includeContinuedFailures: true });
                        if (failureRecoveryKeys.size > before)
                            failureRecoveryActive = true;
                        return walk(child);
                    }
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
                    if (!status.terminal) {
                        // A failure already present in this still-running try child
                        // (e.g. a failed task in a <Parallel> whose sibling is still
                        // in flight) must be recorded as recoverable now, or decide()
                        // fails the run before the try region settles — skipping
                        // catch AND finally. Deferring here lets the region finish so
                        // catch/finally run regardless of which task settles first.
                        const before = failureRecoveryKeys.size;
                        collectFailureKeys(child, { includeContinuedFailures: true });
                        if (failureRecoveryKeys.size > before)
                            failureRecoveryActive = true;
                        return walk(child);
                    }
                    if (status.failed) {
                        tryFailed = true;
                        break;
                    }
                }
                if (tryFailed && node.catchChildren.length > 0) {
                    const collectTryFailureKeys = () => collectChildFailureKeys(node.tryChildren, {
                        includeContinuedFailures: true,
                    });
                    collectTryFailureKeys();
                    const catchStatus = inspect({
                        kind: "sequence",
                        children: node.catchChildren,
                    });
                    failureRecoveryActive = true;
                    const catchFailed = catchStatus.failed;
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
