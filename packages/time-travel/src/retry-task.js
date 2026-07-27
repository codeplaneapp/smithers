import { Effect } from "effect";
import { nowMs } from "@smithers-orchestrator/scheduler/nowMs";
import { markResetCancelledMeta } from "./resetCancelMarker.js";
import { validateWorkflowIdentity } from "./validateWorkflowIdentity.js";
/** @typedef {import("./RetryTaskOptions.ts").RetryTaskOptions} RetryTaskOptions */
/** @typedef {import("./RetryTaskResult.ts").RetryTaskResult} RetryTaskResult */
/** @typedef {import("@smithers-orchestrator/db/adapter").SmithersDb} SmithersDb */

/**
 * @param {string} nodeId
 * @param {number} iteration
 */
function buildNodeKey(nodeId, iteration) {
  return `${nodeId}::${iteration}`;
}
/**
 * @param {Array<{ nodeId: string; iteration: number }>} nodes
 * @returns {string[]}
 */
function uniqueNodeIds(nodes) {
  const seen = new Set();
  const result = [];
  for (const node of nodes) {
    if (seen.has(node.nodeId)) continue;
    seen.add(node.nodeId);
    result.push(node.nodeId);
  }
  return result;
}
/**
 * @param {string | null | undefined} status
 */
function isActiveRunStatus(status) {
  return (
    status === "running" ||
    status === "waiting-approval" ||
    status === "waiting-event" ||
    status === "waiting-timer" ||
    status === "waiting-quota"
  );
}
const RESETTABLE_CHILD_RUN_STATUSES = new Set(["failed", "finished", "cancelled", "canceled"]);
const CHILD_RESET_TARGET_STATES = new Set([
  "waiting-approval",
  "waiting-event",
  "waiting-timer",
  "waiting-quota",
  "waiting-bound",
  "bound-stale",
  "in-progress",
  "failed",
  "cancelled",
]);
/**
 * @param {SmithersDb} adapter
 * @param {Required<Pick<RetryTaskOptions, "runId" | "resetDependents">> & { targetNode: any; }} opts
 */
async function resolveResetNodes(adapter, opts) {
  const { runId, targetNode, resetDependents } = opts;
  if (!resetDependents) {
    return [targetNode];
  }
  const nodes = await adapter.listNodes(runId);
  const attempts = await adapter.listAttemptsForRun(runId);
  const attemptOrder = new Map();
  for (let index = 0; index < attempts.length; index += 1) {
    const attempt = attempts[index];
    attemptOrder.set(buildNodeKey(attempt.nodeId, attempt.iteration ?? 0), index);
  }
  const targetKey = buildNodeKey(targetNode.nodeId, targetNode.iteration ?? 0);
  const targetOrder = attemptOrder.get(targetKey);
  const targetIteration = targetNode.iteration ?? 0;
  const targetUpdatedAtMs = targetNode.updatedAtMs ?? 0;
  return nodes.filter((node) => {
    const nodeIteration = node.iteration ?? 0;
    const nodeKey = buildNodeKey(node.nodeId, nodeIteration);
    if (nodeKey === targetKey) return true;
    if (nodeIteration > targetIteration) return true;
    const nodeOrder = attemptOrder.get(nodeKey);
    if (targetOrder !== undefined && nodeOrder !== undefined) {
      return nodeOrder > targetOrder;
    }
    return (node.updatedAtMs ?? 0) > targetUpdatedAtMs;
  });
}
/**
 * A child-run subflow uses a deterministic run id. Resetting the owning
 * parent node must reset that child too; otherwise prefer-resume immediately
 * replays the child's stale terminal result.
 * @param {SmithersDb} adapter
 * @param {string} runId
 * @param {any[]} resetNodes
 * @param {boolean} resetDependents
 * @param {Set<string>} [seenRunIds]
 */
async function resolveChildResetPlans(adapter, runId, resetNodes, resetDependents, seenRunIds = new Set()) {
  const plans = [];
  for (const resetNode of resetNodes) {
    const iteration = resetNode.iteration ?? 0;
    const childRunId = `${runId}:child:${resetNode.nodeId}:${iteration}`;
    if (seenRunIds.has(childRunId)) continue;
    const childRun = await adapter.getRun(childRunId);
    if (childRun?.parentRunId !== runId || !RESETTABLE_CHILD_RUN_STATUSES.has(childRun.status)) {
      continue;
    }
    seenRunIds.add(childRunId);
    const childNodes = await adapter.listNodes(childRunId);
    const childResetNodes = [];
    const childResetKeys = new Set();
    const addChildResetNodes = (nodes) => {
      for (const node of nodes) {
        const key = buildNodeKey(node.nodeId, node.iteration ?? 0);
        if (childResetKeys.has(key)) continue;
        childResetKeys.add(key);
        childResetNodes.push(node);
      }
    };
    if (childRun.status === "finished") {
      // Explicitly retrying a successfully completed Subflow means re-running
      // that work, so the whole finished child must be reset.
      addChildResetNodes(childNodes);
    } else {
      // A failed child may contain expensive completed work before the failed
      // task. Preserve those outputs and reset only failed/non-terminal work,
      // plus later dependents when requested.
      for (const targetNode of childNodes.filter((node) => CHILD_RESET_TARGET_STATES.has(node.state))) {
        addChildResetNodes(
          await resolveResetNodes(adapter, {
            runId: childRunId,
            targetNode,
            resetDependents,
          }),
        );
      }
    }
    if (childResetNodes.length > 0) {
      plans.push(...(await resolveChildResetPlans(adapter, childRunId, childResetNodes, resetDependents, seenRunIds)), {
        runId: childRunId,
        nodes: childResetNodes,
      });
    }
  }
  return plans;
}
/**
 * @param {RetryTaskOptions} opts
 * @param {{ runId: string; nodeId: string; iteration: number; resetNodes: string[]; success: boolean; error?: string; }} payload
 */
function emitRetryFinished(opts, payload) {
  opts.onProgress?.({
    type: "RetryTaskFinished",
    ...payload,
    timestampMs: nowMs(),
  });
}
/**
 * @param {SmithersDb} adapter
 * @param {RetryTaskOptions} opts
 * @returns {Promise<RetryTaskResult>}
 */
export async function retryTask(adapter, opts) {
  const runId = opts.runId;
  const nodeId = opts.nodeId;
  const iteration = opts.iteration ?? 0;
  const resetDependents = opts.resetDependents ?? true;
  const force = opts.force ?? false;
  const resumeClaim = /** @type {{ claimOwnerId: string; claimHeartbeatAtMs: number } | undefined} */ (
    /** @type {any} */ (opts).resumeClaim
  );
  const node = await adapter.getNode(runId, nodeId, iteration);
  if (!node) {
    const error = `Node not found: ${runId}/${nodeId}/${iteration}`;
    emitRetryFinished(opts, {
      runId,
      nodeId,
      iteration,
      resetNodes: [],
      success: false,
      error,
    });
    return { success: false, resetNodes: [], error };
  }
  const run = await adapter.getRun(runId);
  if (!run) {
    const error = `Run not found: ${runId}`;
    emitRetryFinished(opts, {
      runId,
      nodeId,
      iteration,
      resetNodes: [],
      success: false,
      error,
    });
    return { success: false, resetNodes: [], error };
  }
  if (!force && isActiveRunStatus(run.status)) {
    const error = `Run is still running: ${runId}`;
    emitRetryFinished(opts, {
      runId,
      nodeId,
      iteration,
      resetNodes: [],
      success: false,
      error,
    });
    return { success: false, resetNodes: [], error };
  }
  if ((run.workflowPath || run.workflowHash) && !(await validateWorkflowIdentity(run))) {
    const error = `Cannot retry run because its durable workflow metadata no longer matches: ${runId}`;
    emitRetryFinished(opts, {
      runId,
      nodeId,
      iteration,
      resetNodes: [],
      success: false,
      error,
    });
    return { success: false, resetNodes: [], error };
  }
  if ((run.workflowPath || run.workflowHash) && !(await validateWorkflowIdentity(run))) {
    const error = `Cannot retry run because its durable workflow metadata no longer matches: ${runId}`;
    emitRetryFinished(opts, {
      runId,
      nodeId,
      iteration,
      resetNodes: [],
      success: false,
      error,
    });
    return { success: false, resetNodes: [], error };
  }
  const resetNodes = await resolveResetNodes(adapter, {
    runId,
    targetNode: node,
    resetDependents,
  });
  const resetNodeIds = uniqueNodeIds(
    resetNodes.map((candidate) => ({
      nodeId: candidate.nodeId,
      iteration: candidate.iteration ?? 0,
    })),
  );
  const resetPlans = [
    ...(await resolveChildResetPlans(adapter, runId, resetNodes, resetDependents)),
    { runId, nodes: resetNodes },
  ];
  for (const plan of resetPlans) {
    plan.attemptsByNode = new Map();
    for (const resetNode of plan.nodes) {
      const resetIteration = resetNode.iteration ?? 0;
      plan.attemptsByNode.set(
        buildNodeKey(resetNode.nodeId, resetIteration),
        await adapter.listAttempts(plan.runId, resetNode.nodeId, resetIteration),
      );
    }
  }
  opts.onProgress?.({
    type: "RetryTaskStarted",
    runId,
    nodeId,
    iteration,
    resetDependents,
    resetNodes: resetNodeIds,
    timestampMs: nowMs(),
  });
  const resetTimestampMs = nowMs();
  const resetCommitted = await adapter.withTransaction(
    "retry-task-reset",
    Effect.gen(function* () {
      if (resumeClaim) {
        const claimed = yield* adapter.claimRunForResume({
          runId,
          expectedStatus: run.status,
          expectedRuntimeOwnerId: run.runtimeOwnerId ?? null,
          expectedHeartbeatAtMs: run.heartbeatAtMs ?? null,
          staleBeforeMs: resumeClaim.claimHeartbeatAtMs,
          claimOwnerId: resumeClaim.claimOwnerId,
          claimHeartbeatAtMs: resumeClaim.claimHeartbeatAtMs,
          requireStale: false,
        });
        if (!claimed) return false;
      }
      for (const plan of resetPlans) {
        for (const resetNode of plan.nodes) {
          const resetIteration = resetNode.iteration ?? 0;
          const attempts = plan.attemptsByNode.get(buildNodeKey(resetNode.nodeId, resetIteration)) ?? [];
          for (const attempt of attempts) {
            if (
              attempt.state !== "failed" &&
              attempt.state !== "in-progress" &&
              attempt.state !== "waiting-approval" &&
              attempt.state !== "waiting-event" &&
              attempt.state !== "waiting-timer"
            ) {
              continue;
            }
            const patch = {
              state: "cancelled",
              metaJson: markResetCancelledMeta(attempt.metaJson),
            };
            if (attempt.finishedAtMs == null) {
              patch.finishedAtMs = resetTimestampMs;
            }
            yield* adapter.updateAttemptEffect(plan.runId, resetNode.nodeId, resetIteration, attempt.attempt, patch);
          }
          if (resetNode.outputTable) {
            yield* adapter.deleteOutputRowEffect(resetNode.outputTable, {
              runId: plan.runId,
              nodeId: resetNode.nodeId,
              iteration: resetIteration,
            });
          }
          yield* adapter.insertNodeEffect({
            runId: plan.runId,
            nodeId: resetNode.nodeId,
            iteration: resetIteration,
            state: "pending",
            lastAttempt: resetNode.lastAttempt ?? null,
            updatedAtMs: resetTimestampMs,
            outputTable: resetNode.outputTable ?? "",
            label: resetNode.label ?? null,
          });
        }
        const claimsPlanRun = plan.runId === runId ? resumeClaim : null;
        yield* adapter.updateRunEffect(plan.runId, {
          status: "running",
          finishedAtMs: null,
          heartbeatAtMs: claimsPlanRun?.claimHeartbeatAtMs ?? null,
          runtimeOwnerId: claimsPlanRun?.claimOwnerId ?? null,
          cancelRequestedAtMs: null,
          hijackRequestedAtMs: null,
          hijackTarget: null,
          errorJson: null,
        });
      }
      return true;
    }),
  );
  if (!resetCommitted) {
    const error = `Run changed before retry-task could claim it: ${runId}`;
    emitRetryFinished(opts, {
      runId,
      nodeId,
      iteration,
      resetNodes: [],
      success: false,
      error,
    });
    return { success: false, resetNodes: [], error };
  }
  emitRetryFinished(opts, {
    runId,
    nodeId,
    iteration,
    resetNodes: resetNodeIds,
    success: true,
  });
  return {
    success: true,
    resetNodes: resetNodeIds,
  };
}
