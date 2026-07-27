export declare const SUBFLOW_RUN_LINEAGE_MAX_ROWS: 100000;
export declare function parseSubflowChildRunId(
  runId: string,
  parentRunId: string,
): { nodeId: string; iteration: number } | null;
export declare function subflowRunLineage<T extends {
  runId: string;
  parentRunId?: string | null;
  depth: number;
}>(rows: T[], rootRunId: string, maxRows?: number): T[];
