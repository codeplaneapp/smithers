import {
  SUBFLOW_RUN_LINEAGE_MAX_ROWS,
  parseSubflowChildRunId,
  subflowRunLineage,
} from "@smthrs/graph/subflow-run-lineage";

/**
 * Resolve every run whose workspace checkpoints belong to a parent-facing
 * snapshot request. Older/custom adapters without ancestry support retain the
 * original single-run behavior.
 *
 * @param {{
 *   listRunDescendants?: (runId: string, limit?: number) => Promise<Array<Record<string, any>>>,
 *   listWorkspaceCheckpoints: (runId: string) => Promise<Array<Record<string, any>>>,
 *   listWorkspaceStates: (runId: string) => Promise<Array<Record<string, any>>>,
 * }} adapter
 * @param {string} runId
 */
export async function listScopedWorkspaceSnapshots(adapter, runId) {
  const discoveredScopes =
    typeof adapter.listRunDescendants === "function"
      ? await adapter.listRunDescendants(runId, SUBFLOW_RUN_LINEAGE_MAX_ROWS + 1)
      : [{ runId, parentRunId: null, depth: 0 }];
  const scopes = discoveredScopes.length > 0 ? discoveredScopes : [{ runId, parentRunId: null, depth: 0 }];
  const normalizedScopes = subflowRunLineage(scopes, runId);
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
    const child = parseSubflowChildRunId(direct.runId, runId);
    if (!child) return {};
    return {
      ownerNodeId: child.nodeId,
      ownerIteration: child.iteration,
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
