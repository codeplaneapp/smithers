import { ClaudeWorkflowPhasePlan as ClaudeWorkflowPhasePlan$1 } from './ClaudeWorkflowPhasePlan.js';
import { ClaudeWorkflowNodeKind as ClaudeWorkflowNodeKind$1 } from './ClaudeWorkflowNodePhase.js';
import { TaskDescriptor as TaskDescriptor$1 } from './types.js';
import { GraphSnapshot as GraphSnapshot$1 } from './GraphSnapshot.js';
import './ClaudeWorkflowPhase.js';
import 'zod';
import './ProofBinding.js';

/**
 * Derive a Claude Code /workflows phase plan from a live GraphSnapshot
 * (as produced by `renderFrame` / `smithers graph`).
 *
 * @param {GraphSnapshot} snapshot
 * @param {{ collapsePhases?: boolean }} [options]
 * @returns {ClaudeWorkflowPhasePlan}
 */
declare function deriveClaudeWorkflowPhases(snapshot: GraphSnapshot, options?: {
    collapsePhases?: boolean;
}): ClaudeWorkflowPhasePlan;
type GraphSnapshot = GraphSnapshot$1;
type TaskDescriptor = TaskDescriptor$1;
type ClaudeWorkflowNodeKind = ClaudeWorkflowNodeKind$1;
type ClaudeWorkflowPhasePlan = ClaudeWorkflowPhasePlan$1;

export { type ClaudeWorkflowNodeKind, type ClaudeWorkflowPhasePlan, type GraphSnapshot, type TaskDescriptor, deriveClaudeWorkflowPhases };
