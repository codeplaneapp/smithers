import { Effect } from "effect";
import { nowMs } from "@smthrs/scheduler/nowMs";
import { parseSubflowChildRunId } from "@smthrs/graph/subflow-run-lineage";
import { revertToJjPointer } from "@smthrs/vcs/jj";
import { markResetCancelledMeta } from "./resetCancelMarker.js";
import * as BunContext from "@effect/platform-bun/BunServices";
import { acquireRewindLock, resolveRewindLeaseRunId } from "./acquireRewindLock.js";
import { writeRewindAuditRow } from "./writeRewindAuditRow.js";
import { updateRewindAuditRow } from "./updateRewindAuditRow.js";
import { guardEffectBoundary } from "./guardEffectBoundary.js";
import { archiveDiscardedEffects } from "./archiveDiscardedEffects.js";
import { isRunLikelyLive } from "./isRunLikelyLive.js";
import { classifyRunDriverLiveness, describeLiveDriverRefusal } from "@smthrs/db/runDriverLiveness";
import { markRunNeedsAttention } from "./markRunNeedsAttention.js";
/** @typedef {import("@smthrs/db/adapter").SmithersDb} SmithersDb */
/** @typedef {import("./TimeTravelOptions.ts").TimeTravelOptions} TimeTravelOptions */
/** @typedef {import("./TimeTravelResult.ts").TimeTravelResult} TimeTravelResult */
/** @typedef {import("@smthrs/db").AttemptRow} AttemptRow */
/** @typedef {import("@smthrs/db").NodeRow} NodeRow */

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
const RESETTABLE_CHILD_RUN_STATUSES = new Set([
  "finished",
  "failed",
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
/**
 * @param {any} run
 */
function parseRunConfig(run) {
  try {
    return JSON.parse(run?.configJson ?? "{}");
  } catch {
    return {};
  }
}
/**
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
  const resetKeys = new Set(resetNodes.map((node) => nodeKey(node.nodeId, node.iteration ?? 0)));
  const children = await listOwnedChildRuns(adapter, runId);
  for (const resetNode of resetNodes) {
    const childRunId = `${runId}:child:${resetNode.nodeId}:${resetNode.iteration ?? 0}`;
    if (!children.some((child) => child.runId === childRunId)) {
      const childRun = await adapter.getRun(childRunId);
      if (childRun?.parentRunId === runId) children.push(childRun);
    }
  }
  for (const childRun of children) {
    if (seen.has(childRun.runId) || !RESETTABLE_CHILD_RUN_STATUSES.has(childRun.status)) continue;
    const generated = parseSubflowChildRunId(childRun.runId, runId);
    const explicitSubflow = parseRunConfig(childRun)?.subflowWorkspaceParentRunId === runId && !generated;
    if (!explicitSubflow && (!generated || !resetKeys.has(nodeKey(generated.nodeId, generated.iteration)))) continue;
    plans.push(...(await resolveExistingChildResetPlans(adapter, childRun, seen)));
  }
  return plans;
}
/**
 * @param {SmithersDb} adapter
 * @param {any} childRun
 * @param {Set<string>} seen
 */
async function resolveExistingChildResetPlans(adapter, childRun, seen, resetWholeRun = false) {
  const childRunId = childRun.runId;
  if (seen.has(childRunId) || !RESETTABLE_CHILD_RUN_STATUSES.has(childRun.status)) return [];
  seen.add(childRunId);
  const childNodes = await adapter.listNodes(childRunId);
  const successor = await findContinuationSuccessor(adapter, childRunId);
  const nodes =
    resetWholeRun || childRun.status === "finished" || childRun.status === "continued"
      ? childNodes
      : childNodes.filter((node) => node.state !== "finished" && node.state !== "skipped");
  const successorPlans = successor ? await resolveExistingChildResetPlans(adapter, successor, seen, true) : [];
  if (nodes.length === 0) return successorPlans;
  return [
    ...successorPlans,
    ...(await resolveCompletedChildResetPlans(adapter, childRunId, nodes, seen)),
    { runId: childRunId, nodes },
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
    // Evidence of a live driver (owner PID alive, heartbeating remote owner, or
    // a held resume claim) is refused regardless of `force`: rewinding under a
    // running engine races its frame writes against the truncation, and `force`
    // is asked for by callers who only meant to cross an effect boundary
    // (#1056). Only the separately named `stealOwnership` gets through.
    if (opts.stealOwnership !== true) {
      const liveness = classifyRunDriverLiveness(run, { now: nowMs() });
      if (liveness.live) {
        return {
          success: false,
          vcsRestored: false,
          resetNodes: [],
          error: describeLiveDriverRefusal(runId, liveness),
          effectBoundary: cleanReport,
        };
      }
    }
    if (
      opts.force !== true &&
      opts.stealOwnership !== true &&
      run?.status === "running" &&
      isRunLikelyLive(run, nowMs())
    ) {
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
    // Resolve every durable row the reset will need before changing the
    // working copy. Any lineage/listing failure can then abort without
    // leaving VCS at the target while the database still describes later
    // work.
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
                  metaJson: markResetCancelledMeta(attempt.metaJson, childResetAtMs),
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
          const targetResetAtMs = nowMs();
          for (const resetNode of resetNodes) {
            const attemptsForNode = attemptsByNode.get(nodeKey(resetNode.nodeId, resetNode.iteration ?? 0)) ?? [];
            for (const attempt of attemptsForNode) {
              if ((attempt.startedAtMs ?? 0) < cutoff || attempt.state === "cancelled") {
                continue;
              }
              const patch = {
                state: "cancelled",
                metaJson: markResetCancelledMeta(attempt.metaJson, targetResetAtMs),
              };
              if (attempt.finishedAtMs == null) {
                patch.finishedAtMs = targetResetAtMs;
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
