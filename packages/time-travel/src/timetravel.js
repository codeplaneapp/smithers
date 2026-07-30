import { Effect } from "effect";
import { nowMs } from "@smithers-orchestrator/scheduler/nowMs";
import { revertToJjPointer } from "@smithers-orchestrator/vcs/jj";
import { markResetCancelledMeta } from "./resetCancelMarker.js";
import * as BunContext from "@effect/platform-bun/BunContext";
import { acquireRewindLock, resolveRewindLeaseRunId } from "./acquireRewindLock.js";
import { writeRewindAuditRow } from "./writeRewindAuditRow.js";
import { updateRewindAuditRow } from "./updateRewindAuditRow.js";
import { guardEffectBoundary } from "./guardEffectBoundary.js";
import { archiveDiscardedEffects } from "./archiveDiscardedEffects.js";
import { isRunLikelyLive } from "./isRunLikelyLive.js";
import { markRunNeedsAttention } from "./markRunNeedsAttention.js";
/** @typedef {import("@smithers-orchestrator/db/adapter").SmithersDb} SmithersDb */
/** @typedef {import("./TimeTravelOptions.ts").TimeTravelOptions} TimeTravelOptions */
/** @typedef {import("./TimeTravelResult.ts").TimeTravelResult} TimeTravelResult */
/** @typedef {import("@smithers-orchestrator/db").AttemptRow} AttemptRow */
/** @typedef {import("@smithers-orchestrator/db").NodeRow} NodeRow */

function formatError(error) {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
/**
 * @param {string} nodeId
 * @param {number} iteration
 */
function nodeKey(nodeId, iteration) {
  return `${nodeId}::${iteration}`;
}
/**
 * @param {Array<{ nodeId: string; iteration: number }>} nodes
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
 * @param {any[]} attempts
 * @param {number} [requestedAttempt]
 * @returns {AttemptRow | undefined}
 */
function selectAttempt(attempts, requestedAttempt) {
  if (requestedAttempt == null) return attempts[0];
  return attempts.find((attempt) => attempt.attempt === requestedAttempt);
}
/**
 * @param {NonNullable<AttemptRow>} targetAttempt
 * @param {any[]} attemptsForRun
 */
function findTargetAttemptOrder(targetAttempt, attemptsForRun) {
  return attemptsForRun.findIndex(
    (attempt) =>
      attempt.runId === targetAttempt.runId &&
      attempt.nodeId === targetAttempt.nodeId &&
      (attempt.iteration ?? 0) === (targetAttempt.iteration ?? 0) &&
      attempt.attempt === targetAttempt.attempt,
  );
}
/**
 * @param {SmithersDb} adapter
 * @param {{ runId: string; targetNode: NonNullable<NodeRow>; targetAttempt: NonNullable<AttemptRow>; attemptsForRun: any[]; resetDependents: boolean; }} opts
 */
async function resolveResetNodes(adapter, opts) {
  const { runId, targetNode, targetAttempt, attemptsForRun, resetDependents } = opts;
  if (!resetDependents) {
    return [targetNode];
  }
  const nodes = await adapter.listNodes(runId);
  const targetKey = nodeKey(targetNode.nodeId, targetNode.iteration ?? 0);
  const targetAttemptOrder = findTargetAttemptOrder(targetAttempt, attemptsForRun);
  const targetIteration = targetNode.iteration ?? 0;
  const cutoff = targetAttempt.startedAtMs;
  return nodes.filter((node) => {
    const currentKey = nodeKey(node.nodeId, node.iteration ?? 0);
    if (currentKey === targetKey) return true;
    if ((node.iteration ?? 0) > targetIteration) return true;
    let startedAfterTarget = false;
    let orderedAfterTarget = false;
    for (let index = 0; index < attemptsForRun.length; index += 1) {
      const attempt = attemptsForRun[index];
      if (attempt.nodeId !== node.nodeId || (attempt.iteration ?? 0) !== (node.iteration ?? 0)) {
        continue;
      }
      if ((attempt.startedAtMs ?? 0) >= cutoff) {
        startedAfterTarget = true;
      }
      if (targetAttemptOrder >= 0 && index > targetAttemptOrder) {
        orderedAfterTarget = true;
      }
    }
    return startedAfterTarget || orderedAfterTarget;
  });
}
/**
 * @param {NonNullable<NodeRow>} existingNode
 */
function buildPendingNode(existingNode) {
  return {
    ...existingNode,
    state: "pending",
    updatedAtMs: nowMs(),
  };
}
const TERMINAL_CHILD_RUN_STATUSES = new Set(["finished", "failed", "cancelled", "canceled", "continued"]);
/**
 * @param {SmithersDb} adapter
 * @param {string} runId
 */
async function findContinuationSuccessor(adapter, runId) {
  if (typeof adapter.getLatestChildRun !== "function") return undefined;
  const candidate = await adapter.getLatestChildRun(runId);
  if (!candidate || candidate.parentRunId !== runId) return undefined;
  try {
    const config = JSON.parse(candidate.configJson ?? "{}");
    return config?.continuation?.parentRunId === runId ? candidate : undefined;
  } catch {
    return undefined;
  }
}
/**
 * Resolve terminal child workflows owned by reset parent nodes. Plans are
 * deepest-first so nested children are reset before their owning run.
 *
 * @param {SmithersDb} adapter
 * @param {string} runId
 * @param {any[]} resetNodes
 * @param {Set<string>} [seen]
 * @returns {Promise<Array<{ runId: string; nodes: any[]; attemptsByNode?: Map<string, any[]> }>>}
 */
async function resolveCompletedChildResetPlans(adapter, runId, resetNodes, seen = new Set()) {
  if (typeof adapter.getRun !== "function") return [];
  const plans = [];
  for (const resetNode of resetNodes) {
    const childRunId = `${runId}:child:${resetNode.nodeId}:${resetNode.iteration ?? 0}`;
    if (seen.has(childRunId)) continue;
    const childRun = await adapter.getRun(childRunId);
    if (childRun?.parentRunId !== runId || !TERMINAL_CHILD_RUN_STATUSES.has(childRun.status)) continue;
    plans.push(...(await resolveExistingChildResetPlans(adapter, childRun, seen)));
  }
  return plans;
}
/**
 * @param {SmithersDb} adapter
 * @param {any} childRun
 * @param {Set<string>} seen
 */
async function resolveExistingChildResetPlans(adapter, childRun, seen) {
  const childRunId = childRun.runId;
  if (seen.has(childRunId) || !TERMINAL_CHILD_RUN_STATUSES.has(childRun.status)) return [];
  seen.add(childRunId);
  const childNodes = await adapter.listNodes(childRunId);
  const successor = await findContinuationSuccessor(adapter, childRunId);
  return [
    ...(successor ? await resolveExistingChildResetPlans(adapter, successor, seen) : []),
    ...(await resolveCompletedChildResetPlans(adapter, childRunId, childNodes, seen)),
    { runId: childRunId, nodes: childNodes },
  ];
}
/**
 * @param {SmithersDb} adapter
 * @param {TimeTravelOptions} opts
 * @returns {Promise<TimeTravelResult>}
 */
export async function timeTravel(adapter, opts) {
  const cleanReport = { blocking: [], revertible: [], warnings: [] };
  const runId = opts.runId;
  const nodeId = opts.nodeId;
  const iteration = opts.iteration ?? 0;
  const resetDependents = opts.resetDependents ?? true;
  const restoreVcs = opts.restoreVcs ?? true;
  const attempts = await adapter.listAttempts(runId, nodeId, iteration);
  const targetAttempt = selectAttempt(attempts, opts.attempt);
  if (!targetAttempt) {
    return {
      success: false,
      vcsRestored: false,
      resetNodes: [],
      error: `Attempt not found: ${runId}/${nodeId}/${iteration}/${opts.attempt ?? "latest"}`,
      effectBoundary: cleanReport,
    };
  }
  const targetAttemptNo = targetAttempt.attempt;
  const jjPointer = targetAttempt.jjPointer ?? undefined;
  const targetNode = await adapter.getNode(runId, nodeId, iteration);
  if (!targetNode) {
    return {
      success: false,
      vcsRestored: false,
      resetNodes: [],
      error: `Node not found: ${runId}/${nodeId}/${iteration}`,
      effectBoundary: cleanReport,
    };
  }
  const attemptsForRun = await adapter.listAttemptsForRun(runId);
  const resetNodes = await resolveResetNodes(adapter, {
    runId,
    targetNode,
    targetAttempt,
    attemptsForRun,
    resetDependents,
  });
  const startedAtMs = nowMs();
  const lock = await acquireRewindLock(adapter, runId);
  if (!lock) {
    const leaseRunId = await resolveRewindLeaseRunId(adapter, runId);
    const lockScope = leaseRunId === runId ? runId : `${runId} (lease run ${leaseRunId})`;
    return {
      success: false,
      vcsRestored: false,
      resetNodes: [],
      error: `Another time-travel operation is already running for ${lockScope}.`,
      effectBoundary: cleanReport,
    };
  }
  let auditRowId = null;
  let auditResult = "failed";
  try {
    const run = typeof adapter.getRun === "function" ? await adapter.getRun(runId) : null;
    if (opts.force !== true && run?.status === "running" && isRunLikelyLive(run, nowMs())) {
      return {
        success: false,
        vcsRestored: false,
        resetNodes: [],
        error: `Run ${runId} is still running (live owner or fresh heartbeat). Stop it before time travel, or pass force: true.`,
        effectBoundary: cleanReport,
      };
    }
    auditRowId = await writeRewindAuditRow(adapter, {
      runId,
      fromFrameNo: -1,
      toFrameNo: -1,
      caller: opts.caller ?? "timetravel",
      timestampMs: startedAtMs,
      result: "in_progress",
      durationMs: null,
    });
    if (!(await lock.renew())) {
      throw new Error(`Time-travel lease ownership was lost for ${runId} before compensation.`);
    }
    const boundary = await guardEffectBoundary(adapter, {
      runId,
      cutoffMs: targetAttempt.startedAtMs,
      operation: "timetravel",
      force: opts.force,
      noRevert: opts.noRevert,
      runsReverts: true,
      checkStillHeld: lock.checkStillHeld,
      onProgress: opts.onProgress,
    });
    await opts.hooks?.afterEffectReverts?.();
    opts.onProgress?.({
      type: "TimeTravelStarted",
      runId,
      nodeId,
      iteration,
      attempt: targetAttemptNo,
      jjPointer,
      timestampMs: nowMs(),
    });
    let vcsRestored = false;
    if (restoreVcs && jjPointer) {
      if (!(await lock.renew())) {
        throw new Error(`Time-travel lease ownership was lost for ${runId}.`);
      }
      const vcsResult = await Effect.runPromise(
        revertToJjPointer(jjPointer, targetAttempt.jjCwd ?? undefined).pipe(Effect.provide(BunContext.layer)),
      );
      vcsRestored = vcsResult.success;
      if (!vcsResult.success) {
        const error = vcsResult.error ?? "Failed to restore VCS state";
        opts.onProgress?.({
          type: "TimeTravelFinished",
          runId,
          nodeId,
          iteration,
          attempt: targetAttemptNo,
          jjPointer,
          success: false,
          vcsRestored,
          resetNodes: [],
          error,
          timestampMs: nowMs(),
        });
        return {
          success: false,
          jjPointer,
          vcsRestored,
          resetNodes: [],
          error,
          effectBoundary: boundary.report,
        };
      }
    }
    const resetNodeIds = uniqueNodeIds(
      resetNodes.map((node) => ({
        nodeId: node.nodeId,
        iteration: node.iteration ?? 0,
      })),
    );
    const attemptsByNode = new Map();
    for (const resetNode of resetNodes) {
      attemptsByNode.set(
        nodeKey(resetNode.nodeId, resetNode.iteration ?? 0),
        attemptsForRun.filter(
          (attempt) => attempt.nodeId === resetNode.nodeId && (attempt.iteration ?? 0) === (resetNode.iteration ?? 0),
        ),
      );
    }
    const childResetPlans = await resolveCompletedChildResetPlans(adapter, runId, resetNodes);
    for (const plan of childResetPlans) {
      plan.attemptsByNode = new Map();
      for (const childNode of plan.nodes) {
        const childIteration = childNode.iteration ?? 0;
        plan.attemptsByNode.set(
          nodeKey(childNode.nodeId, childIteration),
          await adapter.listAttempts(plan.runId, childNode.nodeId, childIteration),
        );
      }
    }
    if (!(await lock.renew())) {
      throw new Error(`Time-travel lease ownership was lost for ${runId}.`);
    }
    try {
      await adapter.withTransaction(
        "time-travel",
        Effect.gen(function* () {
          const stillHeld = yield* Effect.promise(() => lock.checkStillHeld());
          if (!stillHeld) {
            throw new Error(`Time-travel lease ownership was lost for ${runId} during database mutation.`);
          }
          const frames = yield* adapter.listFrames(runId, 1_000_000);
          const cutoff = targetAttempt.startedAtMs;
          let lastValidFrameNo = -1;
          for (const frame of frames) {
            if (frame.createdAtMs <= cutoff && frame.frameNo > lastValidFrameNo) {
              lastValidFrameNo = frame.frameNo;
            }
          }
          yield* adapter.deleteFramesAfter(runId, lastValidFrameNo);
          // Truncate snapshots + vcs-tags (keyed run_id, frame_no) with the
          // frames so fork/replay/timeline cannot read discarded state. A cutoff
          // of -1 intentionally removes the entire history.
          yield* adapter.deleteSnapshotsAfter(runId, lastValidFrameNo);
          yield* adapter.deleteVcsTagsAfter(runId, lastValidFrameNo);
          yield* Effect.promise(() =>
            archiveDiscardedEffects(adapter, {
              runId,
              opId: boundary.opId,
              archivedAtMs: nowMs(),
              archiveReason: `timetravel to ${nodeId}/${iteration}/${targetAttemptNo}`,
              cutoffMs: cutoff,
            }),
          );
          const childResetAtMs = nowMs();
          for (const plan of childResetPlans) {
            yield* adapter.deleteFramesAfter(plan.runId, -1);
            yield* adapter.deleteSnapshotsAfter(plan.runId, -1);
            yield* adapter.deleteVcsTagsAfter(plan.runId, -1);
            yield* Effect.promise(() =>
              archiveDiscardedEffects(adapter, {
                runId: plan.runId,
                opId: boundary.opId,
                archivedAtMs: childResetAtMs,
                archiveReason: `parent timetravel to ${nodeId}/${iteration}/${targetAttemptNo}`,
                cutoffMs: 0,
              }),
            );
            for (const childNode of plan.nodes) {
              const childIteration = childNode.iteration ?? 0;
              const childAttempts = plan.attemptsByNode?.get(nodeKey(childNode.nodeId, childIteration)) ?? [];
              for (const attempt of childAttempts) {
                if (attempt.state === "cancelled") continue;
                const patch = {
                  state: "cancelled",
                  metaJson: markResetCancelledMeta(attempt.metaJson),
                };
                if (attempt.finishedAtMs == null) patch.finishedAtMs = childResetAtMs;
                yield* adapter.updateAttempt(plan.runId, childNode.nodeId, childIteration, attempt.attempt, patch);
              }
              if (childNode.outputTable) {
                yield* adapter.deleteOutputRow(childNode.outputTable, {
                  runId: plan.runId,
                  nodeId: childNode.nodeId,
                  iteration: childIteration,
                });
              }
              yield* adapter.insertNode(buildPendingNode(childNode));
            }
            yield* adapter.updateRun(plan.runId, {
              status: "running",
              startedAtMs: childResetAtMs,
              finishedAtMs: null,
              heartbeatAtMs: null,
              runtimeOwnerId: null,
              cancelRequestedAtMs: null,
              hijackRequestedAtMs: null,
              hijackTarget: null,
              errorJson: null,
            });
          }
          for (const resetNode of resetNodes) {
            const attemptsForNode = attemptsByNode.get(nodeKey(resetNode.nodeId, resetNode.iteration ?? 0)) ?? [];
            for (const attempt of attemptsForNode) {
              if ((attempt.startedAtMs ?? 0) < cutoff || attempt.state === "cancelled") {
                continue;
              }
              const patch = {
                state: "cancelled",
                metaJson: markResetCancelledMeta(attempt.metaJson),
              };
              if (attempt.finishedAtMs == null) {
                patch.finishedAtMs = nowMs();
              }
              yield* adapter.updateAttempt(runId, resetNode.nodeId, resetNode.iteration ?? 0, attempt.attempt, patch);
            }
            if (resetNode.outputTable) {
              yield* adapter.deleteOutputRow(resetNode.outputTable, {
                runId,
                nodeId: resetNode.nodeId,
                iteration: resetNode.iteration ?? 0,
              });
            }
            yield* adapter.insertNode(buildPendingNode(resetNode));
          }
          yield* adapter.updateRun(runId, {
            status: "running",
            finishedAtMs: null,
            heartbeatAtMs: null,
            runtimeOwnerId: null,
            cancelRequestedAtMs: null,
            hijackRequestedAtMs: null,
            hijackTarget: null,
            errorJson: null,
          });
        }),
      );
    } catch (error) {
      // The transaction rolled back, so the DB still holds post-target state
      // while the working copy already sits at the target revision. Leave a
      // durable marker instead of letting a resume skip work that is gone.
      const message = `VCS restored to ${jjPointer}, but the time-travel DB reset failed: ${formatError(error)}`;
      const timestampMs = nowMs();
      if (vcsRestored) {
        await markRunNeedsAttention(adapter, {
          runId,
          timestampMs,
          reason: message,
          code: "TimeTravelFailed",
        }).catch(() => undefined);
      }
      opts.onProgress?.({
        type: "TimeTravelFinished",
        runId,
        nodeId,
        iteration,
        attempt: targetAttemptNo,
        jjPointer,
        success: false,
        vcsRestored,
        resetNodes: [],
        error: vcsRestored ? message : formatError(error),
        timestampMs,
      });
      throw error;
    }
    opts.onProgress?.({
      type: "TimeTravelFinished",
      runId,
      nodeId,
      iteration,
      attempt: targetAttemptNo,
      jjPointer,
      success: true,
      vcsRestored,
      resetNodes: resetNodeIds,
      timestampMs: nowMs(),
    });
    auditResult = "success";
    return {
      success: true,
      jjPointer,
      vcsRestored,
      resetNodes: resetNodeIds,
      effectBoundary: boundary.report,
    };
  } finally {
    const durationMs = Math.max(0, nowMs() - startedAtMs);
    if (auditRowId !== null) {
      await updateRewindAuditRow(adapter, {
        id: auditRowId,
        result: auditResult,
        durationMs,
        fromFrameNo: -1,
      }).catch(() => undefined);
    }
    await lock.release().catch(() => undefined);
  }
}
