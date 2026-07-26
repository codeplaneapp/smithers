// `smithers snapshots <runId>` - list durability snapshots (workspace
// checkpoints) for a run, joined with their states for the jj operation id.
// Rows come back camelCase (the storage layer applies snake->camel).

/** @param {unknown} id */
function short(id) {
  return id ? String(id).slice(0, 12) : "";
}

/** @param {number} ms */
function formatAge(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "0s";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

/**
 * @param {{
 *   adapter: { listWorkspaceCheckpoints: (runId: string) => Promise<Array<Record<string, any>>>, listWorkspaceStates: (runId: string) => Promise<Array<Record<string, any>>> },
 *   runId: string,
 *   json?: boolean,
 *   nowMs?: () => number,
 *   stdout: { write: (s: string) => void },
 * }} opts
 * @returns {Promise<{ exitCode: number }>}
 */
export async function runSnapshotsOnce(opts) {
  const { adapter, runId, json = false, nowMs = () => Date.now(), stdout } = opts;
  const checkpoints = await adapter.listWorkspaceCheckpoints(runId);
  const states = await adapter.listWorkspaceStates(runId);
  const opByCommit = new Map();
  for (const s of states) opByCommit.set(`${s.jjCwd}\u0000${s.jjCommitId}`, s.jjOperationId);

  if (json) {
    const rows = checkpoints.map((c) => ({
      seq: c.seq,
      nodeId: c.nodeId,
      iteration: c.iteration,
      attempt: c.attempt,
      tier: c.tier,
      source: c.source,
      label: c.label ?? null,
      commitId: c.jjCommitId,
      operationId: opByCommit.get(`${c.jjCwd}\u0000${c.jjCommitId}`) ?? null,
      cwd: c.jjCwd,
      createdAtMs: c.createdAtMs,
    }));
    stdout.write(`${JSON.stringify({ snapshots: rows }, null, 2)}\n`);
    return { exitCode: 0 };
  }
  if (checkpoints.length === 0) {
    stdout.write(`No durability snapshots for run ${runId}\n`);
    return { exitCode: 0 };
  }
  const now = nowMs();
  for (const c of checkpoints) {
    const op = opByCommit.get(`${c.jjCwd}\u0000${c.jjCommitId}`);
    stdout.write(
      `#${c.seq}  ${c.nodeId} iter=${c.iteration} attempt=${c.attempt}  tier${c.tier}/${c.source}  ${short(c.jjCommitId)}  op:${short(op)}  ${formatAge(now - Number(c.createdAtMs))}  ${c.label ?? ""}\n`,
    );
  }
  return { exitCode: 0 };
}
