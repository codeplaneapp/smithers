import { ClaudeWorkflowNodePhase } from './ClaudeWorkflowNodePhase.js';
import { ClaudeWorkflowPhase } from './ClaudeWorkflowPhase.js';

type ClaudeWorkflowPhasePlan = {
    phases: readonly ClaudeWorkflowPhase[];
    nodes: readonly ClaudeWorkflowNodePhase[];
};

export type { ClaudeWorkflowPhasePlan };
