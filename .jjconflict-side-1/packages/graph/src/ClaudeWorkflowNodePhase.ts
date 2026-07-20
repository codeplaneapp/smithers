export type ClaudeWorkflowNodeKind =
  | "agent"
  | "compute"
  | "static"
  | "human"
  | "wait"
  | "timer"
  | "approval"
  | "subflow"
  | "sandbox"
  | "unknown";

export type ClaudeWorkflowNodePhase = {
  nodeId: string;
  label: string;
  phase: string;
  kind: ClaudeWorkflowNodeKind;
};
