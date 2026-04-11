export type SnapshotData = {
  nodes: Array<{
    nodeId: string;
    iteration: number;
    state: string;
    lastAttempt: number | null;
    outputTable: string;
    label: string | null;
  }>;
  outputs: Record<string, unknown>;
  ralph: Array<{
    ralphId: string;
    iteration: number;
    done: boolean;
  }>;
  input: Record<string, unknown>;
  vcsPointer?: string | null;
  workflowHash?: string | null;
};
