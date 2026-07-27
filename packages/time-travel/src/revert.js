import { Effect } from "effect";
import { revertToJjPointer } from "@smithers-orchestrator/vcs/jj";
import * as BunContext from "@effect/platform-bun/BunContext";
import { nowMs } from "@smithers-orchestrator/scheduler/nowMs";
import { acquireRewindLock, resolveRewindLeaseRunId } from "./acquireRewindLock.js";
import { writeRewindAuditRow } from "./writeRewindAuditRow.js";
import { updateRewindAuditRow } from "./updateRewindAuditRow.js";
import { guardEffectBoundary } from "./guardEffectBoundary.js";
import { archiveDiscardedEffects } from "./archiveDiscardedEffects.js";
import { isRunLikelyLive } from "./isRunLikelyLive.js";
import { markRunNeedsAttention } from "./markRunNeedsAttention.js";
/** @typedef {import("./RevertOptions.ts").RevertOptions} RevertOptions */
/** @typedef {import("./RevertResult.ts").RevertResult} RevertResult */
/** @typedef {import("@smithers-orchestrator/db/adapter").SmithersDb} SmithersDb */

function formatError(error) {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

/**
 * @param {SmithersDb} adapter
 * @param {RevertOptions} opts
 * @returns {Promise<RevertResult>}
 */
export async function revertToAttempt(adapter, opts) {
  const { runId, nodeId, iteration, attempt, onProgress } = opts;
  const cleanReport = { blocking: [], revertible: [], warnings: [] };
  const attemptRow = await Effect.runPromise(adapter.getAttempt(runId, nodeId, iteration, attempt));
  if (!attemptRow) {
    return {
      success: false,
      error: `Attempt not found: ${runId}/${nodeId}/${iteration}/${attempt}`,
      effectBoundary: cleanReport,
    };
  }
  const jjPointer = attemptRow.jjPointer;
  if (!jjPointer) {
    return { success: false, error: `Attempt has no jjPointer recorded`, effectBoundary: cleanReport };
  }
  const startedAtMs = nowMs();
  const lock = await acquireRewindLock(adapter, runId);
  if (!lock) {
    const leaseRunId = await resolveRewindLeaseRunId(adapter, runId);
    const lockScope = leaseRunId === runId ? runId : `${runId} (lease run ${leaseRunId})`;
    return {
      success: false,
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
        error: `Run ${runId} is still running (live owner or fresh heartbeat). Stop it before reverting, or pass force: true.`,
        effectBoundary: cleanReport,
      };
    }
    auditRowId = await writeRewindAuditRow(adapter, {
      runId,
      fromFrameNo: -1,
      toFrameNo: -1,
      caller: opts.caller ?? "revert",
      timestampMs: startedAtMs,
      result: "in_progress",
      durationMs: null,
    });
    if (!(await lock.renew())) {
      throw new Error(`Time-travel lease ownership was lost for ${runId} before compensation.`);
    }
    const boundary = await guardEffectBoundary(adapter, {
      runId,
      cutoffMs: attemptRow.startedAtMs,
      operation: "revert",
      force: opts.force,
      noRevert: opts.noRevert,
      runsReverts: true,
      checkStillHeld: lock.checkStillHeld,
      onProgress,
    });
    await opts.hooks?.afterEffectReverts?.();
    if (!(await lock.renew())) {
      throw new Error(`Time-travel lease ownership was lost for ${runId} before restoring VCS.`);
    }
    onProgress?.({
      type: "RevertStarted",
      runId,
      nodeId,
      iteration,
      attempt,
      jjPointer,
      timestampMs: nowMs(),
    });
    // Revert must target the same repository/worktree where the attempt ran.
    const cwd = attemptRow.jjCwd ?? undefined;
    const result = await Effect.runPromise(revertToJjPointer(jjPointer, cwd).pipe(Effect.provide(BunContext.layer)));
    if (!result.success) {
      onProgress?.({
        type: "RevertFinished",
        runId,
        nodeId,
        iteration,
        attempt,
        jjPointer,
        success: false,
        error: result.error,
        timestampMs: nowMs(),
      });
      return { success: false, error: result.error, jjPointer, effectBoundary: boundary.report };
    }
    // Clean up DB frames recorded after the reverted attempt started.
    // Find the latest frame created before the attempt's start time and
    // discard everything after it so the DB matches the reverted VCS state.
    const frames = await Effect.runPromise(adapter.listFrames(runId, 1_000_000));
    const cutoff = attemptRow.startedAtMs;
    let lastValidFrameNo = -1;
    for (const f of frames) {
      if (f.createdAtMs <= cutoff && f.frameNo > lastValidFrameNo) {
        lastValidFrameNo = f.frameNo;
      }
    }
    try {
      if (!(await lock.renew())) {
        throw new Error(`Time-travel lease ownership was lost for ${runId} before database mutation.`);
      }
      await adapter.withTransaction(
        `revert to attempt ${runId}:${nodeId}:${iteration}:${attempt}`,
        Effect.gen(function* () {
          const stillHeld = yield* Effect.promise(() => lock.checkStillHeld());
          if (!stillHeld) {
            throw new Error(`Time-travel lease ownership was lost for ${runId} during database mutation.`);
          }
          yield* adapter.deleteFramesAfter(runId, lastValidFrameNo);
          // Snapshots and vcs-tags are keyed (run_id, frame_no) and are
          // the fork/hydration source; truncate them atomically with the
          // frames or fork/replay/timeline can read discarded state.
          yield* adapter.deleteSnapshotsAfter(runId, lastValidFrameNo);
          yield* adapter.deleteVcsTagsAfter(runId, lastValidFrameNo);
          yield* Effect.promise(() =>
            archiveDiscardedEffects(adapter, {
              runId,
              opId: boundary.opId,
              archivedAtMs: nowMs(),
              archiveReason: `revert to ${nodeId}/${iteration}/${attempt}`,
              cutoffMs: cutoff,
            }),
          );
        }),
      );
    } catch (error) {
      const message = `VCS restored to ${jjPointer}, but DB frame cleanup failed: ${formatError(error)}`;
      const timestampMs = nowMs();
      await markRunNeedsAttention(adapter, {
        runId,
        timestampMs,
        reason: message,
        code: "RevertFailed",
      });
      onProgress?.({
        type: "RevertFinished",
        runId,
        nodeId,
        iteration,
        attempt,
        jjPointer,
        success: false,
        error: message,
        timestampMs,
      });
      return { success: false, error: message, jjPointer, effectBoundary: boundary.report };
    }
    onProgress?.({
      type: "RevertFinished",
      runId,
      nodeId,
      iteration,
      attempt,
      jjPointer,
      success: true,
      error: undefined,
      timestampMs: nowMs(),
    });
    auditResult = "success";
    return { success: true, jjPointer, effectBoundary: boundary.report };
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
