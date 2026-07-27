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
declare function buildSubflowChildRunId(parentRunId: string, nodeId: string, iteration: number): string;
/**
 * Parse a deterministic child-workflow run id:
 * `<parentRunId>:child:<nodeId>:<iteration>`.
 *
 * @param {string} runId
 * @param {string} parentRunId
 * @returns {{ nodeId: string, iteration: number } | null}
 */
declare function parseSubflowChildRunId(runId: string, parentRunId: string): {
    nodeId: string;
    iteration: number;
} | null;
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
declare function subflowRunLineage<T extends {
    runId: string;
    parentRunId?: string | null;
    depth: number;
}>(rows: T[], rootRunId: string, maxRows?: number): T[];
declare const SUBFLOW_RUN_LINEAGE_MAX_ROWS: 100000;

export { SUBFLOW_RUN_LINEAGE_MAX_ROWS, buildSubflowChildRunId, parseSubflowChildRunId, subflowRunLineage };
