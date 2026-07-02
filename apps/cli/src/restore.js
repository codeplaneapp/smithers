// `smithers restore <runId> --node <id>` — restore a worktree to a durability
// checkpoint (the latest for the node by default, or a specific --seq). Reuses
// the vcs revert (jj restore --from <commit_id>). DI seam on `revert` for tests.

import { spawnSync } from "node:child_process";
import { resolveJjBinary } from "@smithers-orchestrator/vcs/resolveJjBinary";

/** @param {unknown} id */
function short(id) {
    return id ? String(id).slice(0, 12) : "";
}

/**
 * Restore the working copy from a jj commit id (jj restore --from <commit>),
 * shelling out to the resolved jj binary. Mirrors vcs revertToJjPointer without
 * pulling the Effect/platform-bun layer into the CLI.
 * @param {string} commitId
 * @param {string} cwd
 * @returns {Promise<{ success: boolean, error?: string }>}
 */
function defaultRevert(commitId, cwd) {
    let bin = "jj";
    try { bin = resolveJjBinary().path || "jj"; }
    catch { bin = "jj"; }
    const res = spawnSync(bin, ["restore", "--from", commitId], { cwd, encoding: "utf8" });
    if (res.status === 0) return Promise.resolve({ success: true });
    return Promise.resolve({ success: false, error: (res.stderr || `jj exited with code ${res.status}`).trim() });
}

/**
 * Pick the target checkpoint deterministically: filter by node (+optional
 * iteration/seq), then the chronologically latest (ties broken by attempt then
 * seq, since seq resets per attempt).
 * @param {Array<Record<string, any>>} checkpoints
 * @param {{ nodeId: string, iteration?: number, seq?: number }} sel
 */
export function pickTargetCheckpoint(checkpoints, sel) {
    let cands = checkpoints.filter((c) => c.nodeId === sel.nodeId);
    if (sel.iteration !== undefined) cands = cands.filter((c) => Number(c.iteration) === Number(sel.iteration));
    if (sel.seq !== undefined) cands = cands.filter((c) => Number(c.seq) === Number(sel.seq));
    if (cands.length === 0) return null;
    cands.sort((a, b) =>
        Number(a.createdAtMs) - Number(b.createdAtMs)
        || Number(a.attempt) - Number(b.attempt)
        || Number(a.seq) - Number(b.seq));
    return cands[cands.length - 1];
}

/**
 * @param {{
 *   adapter: { listWorkspaceCheckpoints: (runId: string) => Promise<Array<Record<string, any>>> },
 *   runId: string,
 *   nodeId: string,
 *   iteration?: number,
 *   seq?: number,
 *   target?: Record<string, any>,
 *   stdout: { write: (s: string) => void },
 *   stderr: { write: (s: string) => void },
 *   revert?: (commitId: string, cwd: string) => Promise<{ success: boolean, error?: string }>,
 * }} opts
 * @returns {Promise<{ exitCode: number }>}
 */
export async function runRestoreOnce(opts) {
    const { adapter, runId, nodeId, iteration, seq, stdout, stderr } = opts;
    const revert = opts.revert ?? defaultRevert;

    const target = opts.target ??
        pickTargetCheckpoint(await adapter.listWorkspaceCheckpoints(runId), { nodeId, iteration, seq });
    if (!target) {
        stderr.write(`No matching durability checkpoint for run ${runId} node ${nodeId}${seq !== undefined ? ` seq ${seq}` : ""}\n`);
        return { exitCode: 1 };
    }
    const result = await revert(target.jjCommitId, target.jjCwd);
    if (result?.success) {
        stdout.write(`Restored ${target.jjCwd} to checkpoint #${target.seq} (${short(target.jjCommitId)})\n`);
        return { exitCode: 0 };
    }
    stderr.write(`Restore failed: ${result?.error ?? "unknown error"}\n`);
    return { exitCode: 1 };
}
