import { ClaudeWorkflowPhasePlan as ClaudeWorkflowPhasePlan$1 } from './ClaudeWorkflowPhasePlan.js';
import './ClaudeWorkflowNodePhase.js';
import './ClaudeWorkflowPhase.js';

/**
 * Derive a Claude Code /workflows phase plan from a persisted frame row
 * (`_smithers_frames.xml_json` + `task_index_json`), so the plan for a LIVE
 * run comes from the store alone, with no workflow-file execution.
 *
 * `taskIndex` rows are what the engine persists per frame:
 * `{ nodeId, ordinal, iteration, kind }`. Labels are not in the task index;
 * pass the node-table labels so rows read like the workflow, not like ids.
 *
 * @param {{ xmlJson: string | null | undefined; taskIndexJson: string | null | undefined }} frame
 * @param {{ labels?: Record<string, string>; collapsePhases?: boolean }} [options]
 * @returns {ClaudeWorkflowPhasePlan}
 */
declare function deriveClaudeWorkflowPhasesFromFrame(frame: {
    xmlJson: string | null | undefined;
    taskIndexJson: string | null | undefined;
}, options?: {
    labels?: Record<string, string>;
    collapsePhases?: boolean;
}): ClaudeWorkflowPhasePlan;
type ClaudeWorkflowPhasePlan = ClaudeWorkflowPhasePlan$1;

export { type ClaudeWorkflowPhasePlan, deriveClaudeWorkflowPhasesFromFrame };
