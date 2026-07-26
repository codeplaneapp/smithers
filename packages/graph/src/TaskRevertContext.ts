export type TaskRevertContext = {
  outputRow: unknown | null;
  effectStatus: "succeeded" | "unknown";
  runId: string;
  nodeId: string;
  iteration: number;
  attempt: number;
};
