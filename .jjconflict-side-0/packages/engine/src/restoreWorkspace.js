// Restore a worktree to the most recent durability checkpoint for a task, used on
// a resumed attempt so the agent continues against the files it last produced
// rather than a stale or half-written tree.
//
// Restores from the checkpoint's jj commit id (jj restore --from <commit>, via the
// existing revertToJjPointer). DI seam on `revert` keeps it unit-testable; never
// throws, returns a structured result the caller can log or branch on.

import { Effect } from "effect";
import { revertToJjPointer } from "@smithers-orchestrator/vcs/jj";
import { getPlatformLayer } from "./platform-layer.js";

/**
 * @param {string} commitId
 * @param {string} cwd
 * @returns {Promise<{ success: boolean, error?: string }>}
 */
const defaultRevert = (commitId, cwd) => Effect.runPromise(revertToJjPointer(commitId, cwd).pipe(Effect.provide(getPlatformLayer())));

/**
 * Pick the chronologically latest checkpoint, breaking ties by attempt then seq.
 * (seq resets per attempt, so it can't order across attempts on its own.)
 *
 * @param {Array<Record<string, any>>} rows
 */
function latestCheckpoint(rows) {
    let best = null;
    for (const row of rows) {
        if (best == null) { best = row; continue; }
        const a = [Number(row.createdAtMs), Number(row.attempt), Number(row.seq)];
        const b = [Number(best.createdAtMs), Number(best.attempt), Number(best.seq)];
        if (a[0] > b[0] || (a[0] === b[0] && (a[1] > b[1] || (a[1] === b[1] && a[2] > b[2])))) {
            best = row;
        }
    }
    return best;
}

/**
 * @typedef {object} RestoreOptions
 * @property {{ listWorkspaceCheckpoints: (runId: string) => PromiseLike<Array<Record<string, any>>> }} adapter
 * @property {string} runId
 * @property {string} nodeId
 * @property {number} [iteration]
 * @property {(commitId: string, cwd: string) => Promise<{ success: boolean, error?: string }>} [revert]
 */

/**
 * @param {RestoreOptions} opts
 * @returns {Promise<{ restored: boolean, reason?: string, commitId?: string, cwd?: string, seq?: number, error?: string }>}
 */
export async function restoreWorkspaceToLatestCheckpoint(opts) {
    const { adapter, runId, nodeId, iteration = 0, revert = defaultRevert } = opts;

    let rows;
    try { rows = await adapter.listWorkspaceCheckpoints(runId); }
    catch (error) { return { restored: false, reason: "list-failed", error: error instanceof Error ? error.message : String(error) }; }

    const mine = (rows ?? []).filter((row) => row.nodeId === nodeId && Number(row.iteration) === Number(iteration));
    const latest = latestCheckpoint(mine);
    if (!latest) return { restored: false, reason: "no-checkpoint" };

    let result;
    try { result = await revert(latest.jjCommitId, latest.jjCwd); }
    catch (error) {
        return { restored: false, reason: "revert-threw", commitId: latest.jjCommitId, cwd: latest.jjCwd, error: error instanceof Error ? error.message : String(error) };
    }
    if (result?.success) {
        return { restored: true, commitId: latest.jjCommitId, cwd: latest.jjCwd, seq: latest.seq };
    }
    return { restored: false, reason: "revert-failed", commitId: latest.jjCommitId, cwd: latest.jjCwd, error: result?.error };
}

/**
 * Classify a restore result for the durable-resume call site. Returns null when
 * it is safe to proceed (restored, or the benign first-attempt "no-checkpoint"
 * case with nothing to restore), or a structured failure the caller must surface
 * and never swallow: a failed restore means the agent would resume against a
 * stale or half-written tree.
 *
 * @param {{ restored: boolean, reason?: string, commitId?: string, cwd?: string, error?: string }} result
 * @returns {null | { reason: string, commitId?: string, cwd?: string, error?: string }}
 */
export function failedRestoreToSurface(result) {
    if (result.restored) return null;
    if (result.reason === "no-checkpoint") return null;
    return { reason: result.reason ?? "unknown", commitId: result.commitId, cwd: result.cwd, error: result.error };
}
