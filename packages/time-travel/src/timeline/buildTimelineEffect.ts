import { Effect } from "effect";
import type { SmithersDb } from "@smithers/db/adapter";
import type { SmithersError } from "@smithers/errors/SmithersError";
import { listSnapshots } from "../snapshot/listSnapshotsEffect";
import { listBranches } from "../fork/listBranchesEffect";
import { getBranchInfo } from "../fork/getBranchInfoEffect";
import type { BranchInfo } from "../BranchInfo";
import type { RunTimeline } from "../RunTimeline";
import type { TimelineFrame } from "../TimelineFrame";

export function buildTimeline(
  adapter: SmithersDb,
  runId: string,
): Effect.Effect<RunTimeline, SmithersError> {
  return Effect.gen(function* () {
    const snapshots = yield* listSnapshots(adapter, runId);
    const branches = yield* listBranches(adapter, runId);
    const ownBranch = yield* getBranchInfo(adapter, runId);

    // Index branches by parent frame number for fast lookup
    const branchByFrame = new Map<number, BranchInfo[]>();
    for (const b of branches as BranchInfo[]) {
      const existing = branchByFrame.get(b.parentFrameNo) ?? [];
      existing.push(b);
      branchByFrame.set(b.parentFrameNo, existing);
    }

    const frames: TimelineFrame[] = (snapshots as any[]).map((s) => ({
      frameNo: s.frameNo,
      createdAtMs: s.createdAtMs,
      contentHash: s.contentHash,
      forkPoints: branchByFrame.get(s.frameNo) ?? [],
    }));

    return {
      runId,
      frames,
      branch: (ownBranch as BranchInfo | undefined) ?? null,
    };
  }).pipe(
    Effect.annotateLogs({ runId }),
    Effect.withLogSpan("time-travel:build-timeline"),
  );
}
