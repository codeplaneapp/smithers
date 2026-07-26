import { ClaudeWorkflowPhasePlan as ClaudeWorkflowPhasePlan$1 } from './ClaudeWorkflowPhasePlan.js';
import { ClaudeWorkflowNodeKind as ClaudeWorkflowNodeKind$1 } from './ClaudeWorkflowNodePhase.js';
import { XmlNode as XmlNode$1 } from './types.js';
import './ClaudeWorkflowPhase.js';
import 'zod';
import './ProofBinding.js';
import './TaskSideEffect.js';
import './TaskRevertContext.js';

/**
 * Core phase-plan walk shared by the live-snapshot and persisted-frame
 * derivations. Tasks arrive pre-classified: `kind` is taken as-is.
 *
 * @param {XmlNode | null} xml
 * @param {readonly PhasePlanTask[]} inputTasks
 * @param {{ collapsePhases?: boolean }} [options]
 * @returns {ClaudeWorkflowPhasePlan}
 */
declare function buildClaudeWorkflowPhasePlan(xml: XmlNode | null, inputTasks: readonly PhasePlanTask[], options?: {
    collapsePhases?: boolean;
}): ClaudeWorkflowPhasePlan;
type XmlNode = XmlNode$1;
type ClaudeWorkflowNodeKind = ClaudeWorkflowNodeKind$1;
type ClaudeWorkflowPhasePlan = ClaudeWorkflowPhasePlan$1;
type PhasePlanTask = {
    nodeId: string;
    label: string;
    ordinal: number;
    kind: string;
};

export { type ClaudeWorkflowNodeKind, type ClaudeWorkflowPhasePlan, type PhasePlanTask, type XmlNode, buildClaudeWorkflowPhasePlan };
