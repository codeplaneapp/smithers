
/** @typedef {import("../TimelineTree.ts").TimelineTree} TimelineTree */
/**
 * @param {TimelineTree} tree
 * @returns {object}
 */
export function formatTimelineAsJson(tree) {
    return {
        runId: tree.timeline.runId,
        branch: tree.timeline.branch,
        frames: tree.timeline.frames.map((f) => ({
            frameNo: f.frameNo,
            createdAtMs: f.createdAtMs,
            contentHash: f.contentHash,
            forks: f.forkPoints.map((fp) => ({
                runId: fp.runId,
                branchLabel: fp.branchLabel,
                forkDescription: fp.forkDescription,
            })),
        })),
        children: tree.children.map(formatTimelineAsJson),
    };
}
