
/** @typedef {import("../TimelineTree.ts").TimelineTree} TimelineTree */

const TIMELINE_FORMAT_MAX_DEPTH = 100;

/**
 * @param {TimelineTree} tree
 * @returns {object}
 */
export function formatTimelineAsJson(tree) {
    return formatTimelineAsJsonInternal(tree, 0, new WeakSet());
}

/**
 * @param {TimelineTree} tree
 * @param {number} depth
 * @param {WeakSet<object>} activePath
 * @returns {object}
 */
function formatTimelineAsJsonInternal(tree, depth, activePath) {
    if (depth > TIMELINE_FORMAT_MAX_DEPTH) {
        throw new Error(`Timeline JSON formatting exceeds maximum depth of ${TIMELINE_FORMAT_MAX_DEPTH}.`);
    }
    if (typeof tree === "object" && tree !== null) {
        if (activePath.has(tree)) {
            const runId = tree.timeline?.runId ?? "<unknown>";
            throw new Error(`Timeline JSON formatting detected a cycle at run ${runId}.`);
        }
        activePath.add(tree);
    }
    try {
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
            children: tree.children.map((child) => formatTimelineAsJsonInternal(child, depth + 1, activePath)),
        };
    } finally {
        if (typeof tree === "object" && tree !== null) {
            activePath.delete(tree);
        }
    }
}
