export type CrossedEffect = {
  kind: "tool" | "task";
  toolName: string;
  nodeId: string;
  iteration: number;
  attempt: number;
  seq: number;
  effectStatus: "succeeded" | "unknown";
  idempotent: boolean;
  hasRevert: boolean;
  startedAtMs: number;
  reason?: string;
};
