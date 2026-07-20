type ClaudeWorkflowNodeKind = "agent" | "compute" | "static" | "human" | "wait" | "timer" | "approval" | "subflow" | "sandbox" | "unknown";
type ClaudeWorkflowNodePhase = {
    nodeId: string;
    label: string;
    phase: string;
    kind: ClaudeWorkflowNodeKind;
};

export type { ClaudeWorkflowNodeKind, ClaudeWorkflowNodePhase };
