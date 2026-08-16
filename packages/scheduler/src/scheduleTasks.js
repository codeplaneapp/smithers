import { buildStateKey } from "./buildStateKey.js";
import { isTerminalState } from "./isTerminalState.js";
import { parseStateKey } from "./parseStateKey.js";
/** @typedef {import("./TaskState.ts").TaskState} TaskState */

/** @typedef {import("./PlanNode.ts").PlanNode} PlanNode */
/** @typedef {import("./RalphStateMap.ts").RalphStateMap} RalphStateMap */
/** @typedef {import("./RetryWaitMap.ts").RetryWaitMap} RetryWaitMap */
/** @typedef {import("./ScheduleResult.ts").ScheduleResult} ScheduleResult */
/** @typedef {import("@smthrs/graph").TaskDescriptor} TaskDescriptor */
/** @typedef {import("./TaskStateMap.ts").TaskStateMap} TaskStateMap */

/**
 * Effective scheduling priority of a task descriptor (default 0; higher wins
 * when runnable tasks compete for scarce concurrency slots).
 * @param {TaskDescriptor} descriptor
 * @returns {number}
 */
function descriptorPriority(descriptor) {
  const priority = descriptor.priority;
  return typeof priority === "number" && Number.isFinite(priority) ? priority : 0;
}
/**
 * @param {TaskState} state
 * @param {TaskDescriptor} descriptor
 * @returns {boolean}
 */
function isTraversalTerminal(state, descriptor) {
  if (isTerminalState(state, descriptor)) return true;
  if ((state === "failed" || state === "stalled") && descriptor.failurePolicy === "quarantine") return true;
  return Boolean(descriptor.waitAsync && (state === "waiting-approval" || state === "waiting-event"));
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
    if (!dependency) return false;
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
    if (logicalNodeId(descriptor.nodeId) !== forkSource) continue;
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
 * @param {ReadonlyMap<string, unknown>} [taskFailures] recorded failure payloads
 *   keyed by task state key; consulted by the <TryCatchFinally catchErrors>
 *   gate to match failed try tasks against the filtered error codes
 * @param {ReadonlySet<string>} [approvedTaskKeys] approval task keys restored
 *   from durable decisions; these keep their subtree admission across resume
 * @returns {ScheduleResult}
 */
export function scheduleTasks(plan, states, descriptors, ralphState, retryWait, nowMs, taskFailures, approvedTaskKeys) {
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
    if (state !== "in-progress") continue;
    const { nodeId } = parseStateKey(stateKey);
    const descriptor = descriptors.get(nodeId);
    if (!descriptor) continue;
    const groupId = descriptor.parallelGroupId;
    const cap = descriptor.parallelMaxConcurrency;
    if (groupId && cap != null) {
      groupUsage.set(groupId, (groupUsage.get(groupId) ?? 0) + 1);
    }
  }
  // Subtree-concurrency admission (<Parallel subtreeConcurrency>): per
  // subtree group, the set of direct-child keys already ACTIVE. A child is
  // active once any of its tasks has started (any state beyond
  // pending/cancelled) while at least one of its tasks is not yet terminal;
  // a fully terminal child frees its slot. Computed in descriptor order so a
  // resumed run replays the same activation decisions from a restored state
  // map.
  /** @type {Map<string, Set<string>>} */
  const subtreeActiveChildren = new Map();
  {
    /** @type {Map<string, { groupId: string; childKey: string; started: boolean; allTerminal: boolean }>} */
    const childStats = new Map();
    for (const descriptor of descriptors.values()) {
      const groupId = descriptor.subtreeGroupId;
      if (!groupId || descriptor.subtreeMax == null) continue;
      const childKey = descriptor.subtreeChildKey ?? "";
      const statsKey = `${groupId}\u0000${childKey}`;
      let stats = childStats.get(statsKey);
      if (!stats) {
        stats = { groupId, childKey, started: false, allTerminal: true };
        childStats.set(statsKey, stats);
      }
      const state = states.get(buildStateKey(descriptor.nodeId, descriptor.iteration)) ?? "pending";
      const stateKey = buildStateKey(descriptor.nodeId, descriptor.iteration);
      if ((state !== "pending" && state !== "cancelled") || approvedTaskKeys?.has(stateKey)) stats.started = true;
      if (!isTraversalTerminal(state, descriptor)) stats.allTerminal = false;
    }
    for (const stats of childStats.values()) {
      if (!stats.started || stats.allTerminal) continue;
      let active = subtreeActiveChildren.get(stats.groupId);
      if (!active) {
        active = new Set();
        subtreeActiveChildren.set(stats.groupId, active);
      }
      active.add(stats.childKey);
    }
  }
  /**
   * Error codes carried by every failed task inside a plan region.
   * @param {readonly PlanNode[]} children
   * @returns {string[]}
   */
  function collectFailureCodes(children) {
    /** @type {string[]} */
    const codes = [];
    /** @param {PlanNode} node */
    const visit = (node) => {
      switch (node.kind) {
        case "task": {
          const descriptor = descriptors.get(node.nodeId);
          if (!descriptor) return;
          const key = buildStateKey(descriptor.nodeId, descriptor.iteration);
          const taskState = states.get(key) ?? "pending";
          if (taskState !== "failed" && taskState !== "stalled") return;
          const failure = taskFailures?.get(key);
          const code =
            failure &&
            typeof failure === "object" &&
            typeof (/** @type {{ code?: unknown }} */ (failure).code) === "string"
              ? /** @type {{ code: string }} */ (failure).code
              : undefined;
          if (code) codes.push(code);
          return;
        }
        case "sequence":
        case "group":
        case "parallel":
        case "ralph":
          for (const child of node.children) visit(child);
          return;
        case "saga":
          for (const child of node.actionChildren) visit(child);
          for (const child of node.compensationChildren) visit(child);
          return;
        case "try-catch-finally":
          for (const child of node.tryChildren) visit(child);
          for (const child of node.catchChildren) visit(child);
          for (const child of node.finallyChildren) visit(child);
          return;
      }
    };
    for (const child of children) visit(child);
    return codes;
  }
  /**
   * Whether a try-catch-finally node's catch block handles the current try
   * failure. Without a catchErrors filter every failure is handled; with one,
   * at least one failed try task must carry a matching error code — an
   * unmatched failure propagates as if the boundary had no catch block.
   * @param {Extract<PlanNode, { kind: "try-catch-finally" }>} node
   * @returns {boolean}
   */
  function catchArmed(node) {
    if (node.catchChildren.length === 0) return false;
    if (!node.catchErrors || node.catchErrors.length === 0) return true;
    const codes = collectFailureCodes(node.tryChildren);
    return codes.some((code) => node.catchErrors?.includes(code));
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
        if (!descriptor) return { terminal: true, failed: false };
        const state = states.get(buildStateKey(descriptor.nodeId, descriptor.iteration)) ?? "pending";
        const terminal =
          state === "finished" ||
          state === "skipped" ||
          state === "failed" ||
          state === "stalled" ||
          Boolean(descriptor.waitAsync && (state === "waiting-approval" || state === "waiting-event"));
        return {
          terminal,
          failed:
            (state === "failed" || state === "stalled") &&
            (options.includeContinuedFailures || !descriptor.continueOnFail),
        };
      }
      case "sequence":
      case "group": {
        for (const child of node.children) {
          const result = inspect(child, options);
          if (!result.terminal) return { terminal: false, failed: false };
          if (result.failed) return { terminal: true, failed: true };
        }
        return { terminal: true, failed: false };
      }
      case "parallel": {
        let terminal = true;
        let failed = false;
        for (const child of node.children) {
          const result = inspect(child, options);
          if (!result.terminal) terminal = false;
          if (result.failed) failed = true;
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
          if (!result.terminal) return { terminal: false, failed: false };
          if (result.failed) {
            failed = true;
            break;
          }
          completedActions += 1;
        }
        if (!failed) return { terminal: true, failed: false };
        if (node.onFailure === "fail") return { terminal: true, failed: true };
        let compensationFailed = false;
        for (let index = completedActions - 1; index >= 0; index -= 1) {
          const compensation = node.compensationChildren[index];
          if (!compensation) continue;
          const result = inspect(compensation, options);
          if (!result.terminal) return { terminal: false, failed: false };
          if (result.failed) compensationFailed = true;
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
          if (!result.terminal) return { terminal: false, failed: false };
          if (result.failed) {
            tryFailed = true;
            break;
          }
        }
        if (!tryFailed) {
          return inspect(
            {
              kind: "sequence",
              children: node.finallyChildren,
            },
            options,
          );
        }
        const armed = catchArmed(node);
        let catchFailed = !armed;
        if (armed) {
          const catchStatus = inspect(
            {
              kind: "sequence",
              children: node.catchChildren,
            },
            options,
          );
          if (!catchStatus.terminal) return { terminal: false, failed: false };
          catchFailed = catchStatus.failed;
        }
        const finallyStatus = inspect(
          {
            kind: "sequence",
            children: node.finallyChildren,
          },
          options,
        );
        if (!finallyStatus.terminal) return { terminal: false, failed: false };
        return {
          terminal: true,
          failed: catchFailed || finallyStatus.failed,
        };
      }
      case "ralph": {
        const state = ralphState.get(node.id);
        const done = node.until || state?.done;
        if (!done) return { terminal: false, failed: false };
        for (const child of node.children) {
          const result = inspect(child, options);
          if (!result.terminal) return { terminal: false, failed: false };
          if (result.failed) return { terminal: true, failed: true };
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
        if (!descriptor) return;
        const key = buildStateKey(descriptor.nodeId, descriptor.iteration);
        const state = states.get(key) ?? "pending";
        if (
          (state === "failed" || state === "stalled") &&
          (options.includeContinuedFailures || !descriptor.continueOnFail)
        ) {
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
      if (!result.terminal) return { terminal: false };
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
        if (!descriptor) return { terminal: true };
        const state = states.get(buildStateKey(descriptor.nodeId, descriptor.iteration)) ?? "pending";
        if (state === "waiting-approval") waitingApprovalExists = true;
        if (state === "waiting-event") waitingEventExists = true;
        if (state === "waiting-timer") waitingTimerExists = true;
        if (state === "pending" || state === "cancelled") pendingExists = true;
        const terminal = isTraversalTerminal(state, descriptor);
        if (!terminal && (state === "pending" || state === "cancelled")) {
          if (!dependenciesSatisfied(descriptor, states, descriptors)) {
            return { terminal };
          }
          const retryAt = retryWait.get(buildStateKey(descriptor.nodeId, descriptor.iteration));
          if (retryAt && retryAt > nowMs) {
            pendingExists = true;
            nextRetryAtMs = nextRetryAtMs == null ? retryAt : Math.min(nextRetryAtMs, retryAt);
            return { terminal };
          }
          const groupId = descriptor.parallelGroupId;
          const cap = descriptor.parallelMaxConcurrency;
          if (groupId && cap != null) {
            const used = groupUsage.get(groupId) ?? 0;
            if (used >= cap) {
              return { terminal };
            }
          }
          // Subtree cap: a task whose direct-child subtree is already
          // active runs freely (an in-flight child may finish its
          // remaining tasks even while over-cap siblings wait); a task
          // from an inactive child is admitted only while the group has
          // activation headroom, counted in plan-walk (descriptor)
          // order. Composes with the leaf-group cap above and the
          // engine's global cap — all must pass before dispatch.
          const subtreeGroupId = descriptor.subtreeGroupId;
          const subtreeMax = descriptor.subtreeMax;
          /** @type {Set<string> | undefined} */
          let subtreeChildren;
          /** @type {string | undefined} */
          let subtreeChildKey;
          if (subtreeGroupId && subtreeMax != null) {
            subtreeChildKey = descriptor.subtreeChildKey ?? "";
            subtreeChildren = subtreeActiveChildren.get(subtreeGroupId);
            if (!subtreeChildren) {
              subtreeChildren = new Set();
              subtreeActiveChildren.set(subtreeGroupId, subtreeChildren);
            }
            if (!subtreeChildren.has(subtreeChildKey) && subtreeChildren.size >= subtreeMax) {
              return { terminal };
            }
          }
          if (groupId && cap != null) {
            groupUsage.set(groupId, (groupUsage.get(groupId) ?? 0) + 1);
          }
          if (subtreeChildren && subtreeChildKey !== undefined) {
            subtreeChildren.add(subtreeChildKey);
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
          if (!result.terminal) terminal = false;
        }
        return { terminal };
      }
      case "ralph": {
        const state = ralphState.get(node.id);
        const done = node.until || state?.done;
        if (done) return { terminal: true };
        let terminal = true;
        for (const child of node.children) {
          const result = walk(child);
          if (!result.terminal) terminal = false;
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
            if (failureRecoveryKeys.size > before) failureRecoveryActive = true;
            return walk(child);
          }
          if (status.failed) {
            failed = true;
            break;
          }
          completedActions += 1;
        }
        if (!failed) return { terminal: true };
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
          if (!compensation) continue;
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
          if (!compensation) continue;
          const result = walk(compensation);
          if (!result.terminal) return { terminal: false };
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
            if (failureRecoveryKeys.size > before) failureRecoveryActive = true;
            return walk(child);
          }
          if (status.failed) {
            tryFailed = true;
            break;
          }
        }
        const armed = tryFailed && catchArmed(node);
        if (armed) {
          const collectTryFailureKeys = () =>
            collectChildFailureKeys(node.tryChildren, {
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
            if (!catchResult.terminal) return catchResult;
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
          if (tryFailed && !armed) {
            collectChildFailureKeys(node.tryChildren, {
              includeContinuedFailures: true,
            });
            failureRecoveryActive = true;
          }
          return finallyResult;
        }
        if (tryFailed && !armed) {
          fatalError ??= `TryCatchFinally ${node.id} failed`;
        }
        return { terminal: true };
      }
      case "group": {
        let terminal = true;
        for (const child of node.children) {
          const result = walk(child);
          if (!result.terminal) terminal = false;
        }
        return { terminal };
      }
      default:
        return { terminal: true };
    }
  }
  if (plan) walk(plan);
  // Priority ordering: when more tasks are runnable than free concurrency
  // slots, higher-priority tasks must claim slots first — the session and
  // driver dispatch (and the engine's slot queue) consume `runnable` in
  // order. The sort is stable (spec-guaranteed), so equal priorities keep
  // plan-walk order, and the all-default fast path returns the walk order
  // untouched. Group/subtree admission above already ran in plan order and
  // is unaffected: priority only reorders tasks that were ALL admitted.
  if (runnable.some((task) => descriptorPriority(task) !== 0)) {
    runnable.sort((left, right) => descriptorPriority(right) - descriptorPriority(left));
  }
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
