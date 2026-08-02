import { Effect } from "effect";
import { nowMs } from "@smthrs/scheduler/nowMs";
import { parseSubflowChildRunId } from "@smthrs/graph/subflow-run-lineage";
import { markResetCancelledMeta } from "./resetCancelMarker.js";
import { validateWorkflowIdentity } from "./validateWorkflowIdentity.js";
/** @typedef {import("./RetryTaskOptions.ts").RetryTaskOptions} RetryTaskOptions */
/** @typedef {import("./RetryTaskResult.ts").RetryTaskResult} RetryTaskResult */
/** @typedef {import("@smthrs/db/adapter").SmithersDb} SmithersDb */

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
const RESETTABLE_CHILD_RUN_STATUSES = new Set([
  "failed",
  "finished",
  "cancelled",
  "canceled",
  "continued",
  "waiting-approval",
  "waiting-event",
  "waiting-timer",
  "waiting-quota",
  "waiting-bound",
  "bound-stale",
  "paused",
]);
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
 * ContinueAsNew records its successor as a child row and stamps the source
 * run id into config.continuation.parentRunId. Follow that structured
 * provenance rather than treating every parentRunId child (Subflow or fork)
 * as a continuation.
 * @param {SmithersDb} adapter
 * @param {string} runId
 */
function parseRunConfig(run) {
  try {
    return JSON.parse(run?.configJson ?? "{}");
  } catch {
    return {};
  }
}
/**
 * Load direct owned descendants from durable parent/config lineage. Forks and
 * monitor sidecars also use parentRunId, so only structured Subflow and
 * ContinueAsNew provenance is accepted (plus the legacy generated id grammar).
 *
 * @param {SmithersDb} adapter
 * @param {string} runId
 */
async function listOwnedChildRuns(adapter, runId) {
  const candidates = [];
  if (typeof adapter.listRunDescendants === "function" && typeof adapter.getRun === "function") {
    const descendants = await adapter.listRunDescendants(runId);
    for (const descendant of descendants) {
      if (descendant.runId === runId || (descendant.depth !== 1 && descendant.parentRunId !== runId)) continue;
      const child = await adapter.getRun(descendant.runId);
      if (child?.parentRunId === runId) candidates.push(child);
    }
  } else if (typeof adapter.listRuns === "function") {
    candidates.push(...(await adapter.listRuns(1_000, undefined, undefined, { parentRunId: runId })));
  }
  return candidates.filter((child) => {
    const config = parseRunConfig(child);
    return (
      config?.subflowWorkspaceParentRunId === runId ||
      config?.continuation?.parentRunId === runId ||
      Boolean(parseSubflowChildRunId(child.runId, runId))
    );
  });
}
/**
 * @param {SmithersDb} adapter
 * @param {string} runId
 */
async function findContinuationSuccessor(adapter, runId) {
  const owned = await listOwnedChildRuns(adapter, runId);
  const successor = owned
    .filter((candidate) => parseRunConfig(candidate)?.continuation?.parentRunId === runId)
    .sort((left, right) => Number(right.createdAtMs ?? 0) - Number(left.createdAtMs ?? 0))[0];
  if (successor) return successor;
  if (typeof adapter.getLatestChildRun !== "function") return undefined;
  const candidate = await adapter.getLatestChildRun(runId);
  return candidate?.parentRunId === runId && parseRunConfig(candidate)?.continuation?.parentRunId === runId
    ? candidate
    : undefined;
}
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
  const resetKeys = new Set(resetNodes.map((node) => buildNodeKey(node.nodeId, node.iteration ?? 0)));
  const children = await listOwnedChildRuns(adapter, runId);
  for (const resetNode of resetNodes) {
    const iteration = resetNode.iteration ?? 0;
    const childRunId = `${runId}:child:${resetNode.nodeId}:${iteration}`;
    if (!children.some((child) => child.runId === childRunId) && typeof adapter.getRun === "function") {
      const childRun = await adapter.getRun(childRunId);
      if (childRun?.parentRunId === runId) children.push(childRun);
    }
  }
  for (const childRun of children) {
    if (seenRunIds.has(childRun.runId) || !RESETTABLE_CHILD_RUN_STATUSES.has(childRun.status)) continue;
    const generated = parseSubflowChildRunId(childRun.runId, runId);
    const config = parseRunConfig(childRun);
    const explicitSubflow = config?.subflowWorkspaceParentRunId === runId && !generated;
    if (!explicitSubflow && (!generated || !resetKeys.has(buildNodeKey(generated.nodeId, generated.iteration))))
      continue;
    plans.push(...(await resolveExistingChildResetPlans(adapter, childRun, resetDependents, seenRunIds)));
  }
  return plans;
}
/**
 * Build a reset for one child plus every ContinueAsNew successor. Successors
 * are planned first, so the durable lineage is invalidated deepest-first
 * before the deterministic predecessor is made resumable again.
 * @param {SmithersDb} adapter
 * @param {any} childRun
 * @param {boolean} resetDependents
 * @param {Set<string>} seenRunIds
 */
async function resolveExistingChildResetPlans(adapter, childRun, resetDependents, seenRunIds, resetWholeRun = false) {
  const childRunId = childRun.runId;
  if (seenRunIds.has(childRunId) || !RESETTABLE_CHILD_RUN_STATUSES.has(childRun.status)) return [];
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
  if (resetWholeRun || childRun.status === "finished" || childRun.status === "continued") {
    // A continued predecessor must be reset wholesale. Leaving it continued
    // makes executeChildWorkflow try to resume a non-resumable run.
    addChildResetNodes(childNodes);
  } else {
    for (const targetNode of childNodes.filter((node) => CHILD_RESET_TARGET_STATES.has(node.state))) {
      addChildResetNodes(
        await resolveResetNodes(adapter, {
          runId: childRunId,
          targetNode,
          resetDependents,
        }),
      );
    }
    if (
      childResetNodes.length === 0 &&
      (childRun.status?.startsWith("waiting-") || childRun.status === "paused" || childRun.status === "bound-stale")
    ) {
      addChildResetNodes(childNodes.filter((node) => node.state === "pending"));
    }
  }
  const successor = await findContinuationSuccessor(adapter, childRunId);
  const successorPlans = successor
    ? await resolveExistingChildResetPlans(adapter, successor, resetDependents, seenRunIds, true)
    : [];
  if (childResetNodes.length === 0) return successorPlans;
  return [
    ...successorPlans,
    ...(await resolveChildResetPlans(adapter, childRunId, childResetNodes, resetDependents, seenRunIds)),
    { runId: childRunId, nodes: childResetNodes },
  ];
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
  const acceptWorkflowChange = /** @type {any} */ (opts).acceptWorkflowChange === true;
  const resumeClaim = /** @type {{ claimOwnerId: string; claimHeartbeatAtMs: number } | undefined} */ (
    /** @type {any} */ (opts).resumeClaim
  );
  const beforeReset = /** @type {((plan: { runIds: string[] }) => Promise<void>) | undefined} */ (
    /** @type {any} */ (opts).beforeReset
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
  if ((run.workflowPath || run.workflowHash) && !acceptWorkflowChange && !(await validateWorkflowIdentity(run))) {
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
      if (beforeReset) {
        yield* Effect.promise(() => beforeReset({ runIds: resetPlans.map((plan) => plan.runId) }));
      }
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
              attempt.state !== "waiting-timer" &&
              attempt.state !== "waiting-quota"
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
