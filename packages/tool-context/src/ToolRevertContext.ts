export type ToolRevertContext<Output = unknown> = {
  output: Output | null;
  effectStatus: "succeeded" | "unknown";
  idempotencyKey: string | null;
  runId: string;
  nodeId: string;
  iteration: number;
  attempt: number;
  toolCallSeq: number;
};
