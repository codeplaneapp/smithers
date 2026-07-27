/**
 * Resolve every run whose workspace checkpoints belong to a parent-facing
 * snapshot request. Older/custom adapters without ancestry support retain the
 * original single-run behavior.
 *
 * @param {{
 *   listRunDescendants?: (runId: string) => Promise<Array<Record<string, any>>>,
 *   listWorkspaceCheckpoints: (runId: string) => Promise<Array<Record<string, any>>>,
 *   listWorkspaceStates: (runId: string) => Promise<Array<Record<string, any>>>,
 * }} adapter
 * @param {string} runId
 */
export async function listScopedWorkspaceSnapshots(adapter, runId) {
  const discoveredScopes =
    typeof adapter.listRunDescendants === "function"
      ? await adapter.listRunDescendants(runId)
      : [{ runId, parentRunId: null, depth: 0 }];
  const scopes = discoveredScopes.length > 0 ? discoveredScopes : [{ runId, parentRunId: null, depth: 0 }];
  const includedRunIds = new Set([runId]);
  const normalizedScopes = scopes.filter((scope) => {
    if (scope.runId === runId && Number(scope.depth) === 0) return true;
    if (!scope.parentRunId || !includedRunIds.has(scope.parentRunId)) return false;
    const prefix = `${scope.parentRunId}:child:`;
    if (!String(scope.runId).startsWith(prefix)) return false;
    const suffix = String(scope.runId).slice(prefix.length);
    const splitAt = suffix.lastIndexOf(":");
    const iteration = Number(suffix.slice(splitAt + 1));
    if (splitAt <= 0 || !Number.isInteger(iteration) || iteration < 0) return false;
    includedRunIds.add(scope.runId);
    return true;
  });
  const scopeByRunId = new Map(normalizedScopes.map((scope) => [scope.runId, scope]));

  /**
   * Map a descendant back to the direct child-run node exposed by the root
   * graph. Child-run ids are deterministic: <parent>:child:<node>:<iteration>.
   * @param {Record<string, any>} scope
   */
  const rootOwner = (scope) => {
    let direct = scope;
    while (direct.depth > 1) {
      const parent = scopeByRunId.get(direct.parentRunId);
      if (!parent) return {};
      direct = parent;
    }
    if (direct.depth !== 1) return {};
    const prefix = `${runId}:child:`;
    if (!String(direct.runId).startsWith(prefix)) return {};
    const suffix = String(direct.runId).slice(prefix.length);
    const splitAt = suffix.lastIndexOf(":");
    if (splitAt <= 0) return {};
    const iteration = Number(suffix.slice(splitAt + 1));
    if (!Number.isInteger(iteration) || iteration < 0) return {};
    return {
      ownerNodeId: suffix.slice(0, splitAt),
      ownerIteration: iteration,
    };
  };

  const rows = await Promise.all(
    normalizedScopes.map(async (scope) => {
      const [checkpoints, states] = await Promise.all([
        adapter.listWorkspaceCheckpoints(scope.runId),
        adapter.listWorkspaceStates(scope.runId),
      ]);
      const owner = rootOwner(scope);
      return {
        checkpoints: checkpoints.map((checkpoint) => ({
          ...checkpoint,
          runId: scope.runId,
          ...owner,
        })),
        states: states.map((state) => ({ ...state, runId: scope.runId })),
      };
    }),
  );
  const checkpoints = rows
    .flatMap((row) => row.checkpoints)
    .sort(
      (a, b) =>
        Number(a.createdAtMs) - Number(b.createdAtMs) ||
        String(a.runId).localeCompare(String(b.runId)) ||
        Number(a.seq) - Number(b.seq),
    );
  return {
    checkpoints,
    states: rows.flatMap((row) => row.states),
  };
}
