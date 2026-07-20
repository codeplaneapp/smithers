// Best-effort prune of the durability tables for a run, to bound their growth.
// Keeps the latest checkpoint per (node,iteration,attempt) and the most recent
// states per run, so resume-restore targets always survive. Never throws — a
// prune failure must not affect the run.
//
// Called from startDurability.stop() (per attempt, run-scoped) so it needs no
// edit to the engine's hot finalize path. jj `util gc` retention must exceed this
// window, since operation_id is the durable handle behind a kept commit.

/**
 * @typedef {object} PruneConfig
 * @property {number} [stateRetentionPerRun]       default 50
 * @property {number} [checkpointRetentionPerScope] default 100
 */

/**
 * @param {{
 *   adapter: { pruneWorkspaceStates: (runId: string, n: number) => PromiseLike<unknown>, pruneWorkspaceCheckpoints: (runId: string, n: number) => PromiseLike<unknown> },
 *   runId: string,
 *   config?: PruneConfig,
 * }} opts
 * @returns {Promise<void>}
 */
export async function pruneWorkspaceDurability(opts) {
    const { adapter, runId, config = {} } = opts;
    const states = Math.max(1, config.stateRetentionPerRun ?? 50);
    const checkpoints = Math.max(1, config.checkpointRetentionPerScope ?? 100);
    try { await adapter.pruneWorkspaceCheckpoints(runId, checkpoints); }
    catch { /* best-effort: prune failure never affects the run */ }
    try { await adapter.pruneWorkspaceStates(runId, states); }
    catch { /* best-effort */ }
}
