export const SUBFLOW_RUN_LINEAGE_MAX_ROWS = 100_000;

/**
 * Build the deterministic child-workflow run id for a Subflow node:
 * `<parentRunId>:child:<nodeId>:<iteration>`. The single source of the
 * format `parseSubflowChildRunId` decodes.
 *
 * @param {string} parentRunId
 * @param {string} nodeId
 * @param {number} iteration
 * @returns {string}
 */
export function buildSubflowChildRunId(parentRunId, nodeId, iteration) {
  return [parentRunId, "child", nodeId, String(iteration)].join(":");
}

/**
 * Parse a deterministic child-workflow run id:
 * `<parentRunId>:child:<nodeId>:<iteration>`.
 *
 * @param {string} runId
 * @param {string} parentRunId
 * @returns {{ nodeId: string, iteration: number } | null}
 */
export function parseSubflowChildRunId(runId, parentRunId) {
  const prefix = `${parentRunId}:child:`;
  if (!String(runId).startsWith(prefix)) return null;
  const suffix = String(runId).slice(prefix.length);
  const splitAt = suffix.lastIndexOf(":");
  if (splitAt <= 0) return null;
  const iteration = Number(suffix.slice(splitAt + 1));
  if (!Number.isInteger(iteration) || iteration < 0) return null;
  return { nodeId: suffix.slice(0, splitAt), iteration };
}

/**
 * `parent_run_id` also links time-travel forks and continue-as-new segments.
 * Keep only deterministic child-workflow edges. The closure is independent of
 * database row order, and an explicitly truncated query fails rather than
 * silently omitting a child subtree.
 *
 * @template {{ runId: string; parentRunId?: string | null; depth: number }} T
 * @param {T[]} rows
 * @param {string} rootRunId
 * @param {number} [maxRows]
 * @returns {T[]}
 */
export function subflowRunLineage(rows, rootRunId, maxRows = SUBFLOW_RUN_LINEAGE_MAX_ROWS) {
  if (rows.length > maxRows) {
    throw new Error(`Subflow run lineage for ${rootRunId} exceeds ${maxRows} rows`);
  }
  const childrenByParent = new Map();
  for (const row of rows) {
    if (!row.parentRunId || !parseSubflowChildRunId(row.runId, row.parentRunId)) continue;
    const children = childrenByParent.get(row.parentRunId) ?? [];
    children.push(row);
    childrenByParent.set(row.parentRunId, children);
  }
  const includedRunIds = new Set([rootRunId]);
  const queue = [rootRunId];
  while (queue.length > 0) {
    const parentRunId = queue.shift();
    for (const child of childrenByParent.get(parentRunId) ?? []) {
      if (includedRunIds.has(child.runId)) continue;
      includedRunIds.add(child.runId);
      queue.push(child.runId);
    }
  }
  return rows.filter((row) => includedRunIds.has(row.runId));
}
