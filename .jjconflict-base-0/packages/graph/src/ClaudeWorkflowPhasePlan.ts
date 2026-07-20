import type { ClaudeWorkflowNodePhase } from "./ClaudeWorkflowNodePhase";
import type { ClaudeWorkflowPhase } from "./ClaudeWorkflowPhase";

export type ClaudeWorkflowPhasePlan = {
  phases: readonly ClaudeWorkflowPhase[];
  nodes: readonly ClaudeWorkflowNodePhase[];
};
