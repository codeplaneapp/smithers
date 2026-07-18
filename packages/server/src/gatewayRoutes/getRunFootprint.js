import { RUN_ID_PATTERN, getNodeDiffRoute } from "./getNodeDiff.js";
import { aggregateFootprint } from "./aggregateFootprint.js";

const memos = new Map();
const MEMO_LIMIT = 32;
export class RunFootprintError extends Error {
    constructor(code, message) { super(message); this.code = code; }
}

/** Return a compact, incrementally cached rollup of settled node diff stats. */
export async function getRunFootprintRoute({ runId, resolveRun, getNodeDiffRouteImpl = getNodeDiffRoute, nowMs = () => Date.now() }) {
    if (typeof runId !== "string" || !RUN_ID_PATTERN.test(runId)) throw new RunFootprintError("InvalidRunId", "runId must match /^[a-z0-9_-]{1,64}$/.");
    const resolved = await resolveRun(runId);
    if (!resolved) throw new RunFootprintError("RunNotFound", `Run not found: ${runId}`);
    const attempts = await resolved.adapter.listAttemptsForRun(runId);
    const latest = new Map();
    for (const row of attempts) {
        const nodeId = row.nodeId ?? row.node_id;
        const iteration = row.iteration;
        const attempt = row.attempt ?? row.attempt_number;
        if (typeof nodeId !== "string" || !Number.isInteger(iteration) || !Number.isFinite(attempt)) continue;
        const key = `${nodeId}\0${iteration}`;
        if (!latest.has(key) || attempt > (latest.get(key).attempt ?? latest.get(key).attempt_number ?? -1)) latest.set(key, row);
    }
    const settled = [...latest.values()].filter((row) => {
        const state = row.state ?? row.status;
        return state !== "in-progress" && typeof (row.jjPointer ?? row.jj_pointer) === "string" && (row.jjPointer ?? row.jj_pointer).length > 0;
    });
    // Attempt count catches same-node retries which do not change settled count.
    const freshness = `${settled.length}:${attempts.length}`;
    let memo = memos.get(runId);
    if (memo?.freshness === freshness) return memo.value;
    memo ??= { nodeStats: new Map() };
    const results = Array.from({ length: settled.length });
    let skippedNodes = 0;
    let cursor = 0;
    const workers = Array.from({ length: Math.min(4, settled.length) }, async () => {
        while (cursor < settled.length) {
            const index = cursor++;
            const row = settled[index];
            const nodeId = row.nodeId ?? row.node_id;
            const iteration = row.iteration;
            const attempt = row.attempt ?? row.attempt_number;
            const pointer = row.jjPointer ?? row.jj_pointer;
            const key = `${nodeId}\0${iteration}\0${attempt}\0${pointer}`;
            try {
                let summary = memo.nodeStats.get(key);
                if (!summary) {
                    const result = await getNodeDiffRouteImpl({ runId, nodeId, iteration, resolveRun, stat: true, nowMs });
                    summary = result?.payload?.summary;
                    if (!result?.ok || !summary) throw new Error("diff stat unavailable");
                    memo.nodeStats.set(key, summary);
                }
                // Preserve attempt-row order even when VCS reads finish out of
                // order, so equal-churn ranking and owner ties stay stable.
                results[index] = { nodeId, iteration, summary };
            } catch { skippedNodes += 1; }
        }
    });
    await Promise.all(workers);
    const value = { runId, ...aggregateFootprint(results.filter(Boolean)), skippedNodes };
    memo.freshness = freshness;
    memo.value = value;
    memos.delete(runId); memos.set(runId, memo);
    if (memos.size > MEMO_LIMIT) memos.delete(memos.keys().next().value);
    return value;
}
