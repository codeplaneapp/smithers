import { Effect } from "effect";
import { listSnapshots } from "../snapshot/listSnapshotsEffect.js";
import { listBranches } from "../fork/listBranchesEffect.js";
import { getBranchInfo } from "../fork/getBranchInfoEffect.js";
/** @typedef {import("../RunTimeline.ts").RunTimeline} RunTimeline */
/** @typedef {import("@smithers-orchestrator/db/adapter").SmithersDb} SmithersDb */
/** @typedef {import("@smithers-orchestrator/errors/SmithersError").SmithersError} SmithersError */

const ONESHOT_CONTROL_EVENT_PREFIXES = ["OneshotSteer", "OneshotRestart"];

/** @param {string} value */
function parsePayload(value) {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * @param {SmithersDb} adapter
 * @param {string} runId
 * @returns {Effect.Effect<RunTimeline, SmithersError>}
 */
export function buildTimeline(adapter, runId) {
  return Effect.gen(function* () {
    const snapshots = yield* listSnapshots(adapter, runId);
    const branches = yield* listBranches(adapter, runId);
    const ownBranch = yield* getBranchInfo(adapter, runId);
    const controls = [];
    if (typeof adapter.listEvents === "function") {
      let afterSeq = -1;
      for (;;) {
        const events = yield* adapter.listEvents(runId, afterSeq, 1_000);
        if (events.length === 0) break;
        const previousSeq = afterSeq;
        for (const event of events) {
          afterSeq = Math.max(afterSeq, Number(event.seq ?? -1));
          if (!ONESHOT_CONTROL_EVENT_PREFIXES.some((prefix) => event.type.startsWith(prefix))) continue;
          controls.push({
            seq: Number(event.seq ?? 0),
            type: event.type,
            timestampMs: event.timestampMs,
            payload: parsePayload(event.payloadJson),
          });
        }
        if (events.length < 1_000 || afterSeq === previousSeq) break;
      }
    }
    // Index branches by parent frame number for fast lookup
    const branchByFrame = new Map();
    for (const b of branches) {
      const existing = branchByFrame.get(b.parentFrameNo) ?? [];
      existing.push(b);
      branchByFrame.set(b.parentFrameNo, existing);
    }
    const frames = snapshots.map((s) => ({
      frameNo: s.frameNo,
      createdAtMs: s.createdAtMs,
      contentHash: s.contentHash,
      forkPoints: branchByFrame.get(s.frameNo) ?? [],
    }));
    return {
      runId,
      frames,
      branch: ownBranch ?? null,
      ...(controls.length > 0 ? { controls } : {}),
    };
  }).pipe(Effect.annotateLogs({ runId }), Effect.withLogSpan("time-travel:build-timeline"));
}
