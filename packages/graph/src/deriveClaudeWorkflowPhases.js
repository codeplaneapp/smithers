/** @typedef {import("./GraphSnapshot.ts").GraphSnapshot} GraphSnapshot */
/** @typedef {import("./TaskDescriptor.ts").TaskDescriptor} TaskDescriptor */
/** @typedef {import("./ClaudeWorkflowNodePhase.ts").ClaudeWorkflowNodeKind} ClaudeWorkflowNodeKind */
/** @typedef {import("./ClaudeWorkflowPhasePlan.ts").ClaudeWorkflowPhasePlan} ClaudeWorkflowPhasePlan */

import { buildClaudeWorkflowPhasePlan } from "./buildClaudeWorkflowPhasePlan.js";
import { classifyClaudeWorkflowNodeKind } from "./classifyClaudeWorkflowNodeKind.js";

/**
 * Derive a Claude Code /workflows phase plan from a live GraphSnapshot
 * (as produced by `renderFrame` / `smithers graph`).
 *
 * @param {GraphSnapshot} snapshot
 * @param {{ collapsePhases?: boolean }} [options]
 * @returns {ClaudeWorkflowPhasePlan}
 */
export function deriveClaudeWorkflowPhases(snapshot, options = {}) {
    const tasks = (snapshot.tasks ?? []).map((task) => ({
        nodeId: task.nodeId,
        label: task.label || task.nodeId,
        ordinal: task.ordinal ?? 0,
        kind: classifyClaudeWorkflowNodeKind(task),
    }));
    return buildClaudeWorkflowPhasePlan(snapshot.xml ?? null, tasks, options);
}
