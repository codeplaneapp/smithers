/** @typedef {import("./GraphSnapshot.ts").GraphSnapshot} GraphSnapshot */
/** @typedef {import("./TaskDescriptor.ts").TaskDescriptor} TaskDescriptor */
/** @typedef {import("./ClaudeWorkflowNodePhase.ts").ClaudeWorkflowNodeKind} ClaudeWorkflowNodeKind */
/** @typedef {import("./ClaudeWorkflowPhasePlan.ts").ClaudeWorkflowPhasePlan} ClaudeWorkflowPhasePlan */

import { buildClaudeWorkflowPhasePlan } from "./buildClaudeWorkflowPhasePlan.js";

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
        kind: classifyTask(task),
    }));
    return buildClaudeWorkflowPhasePlan(snapshot.xml ?? null, tasks, options);
}

/**
 * @param {TaskDescriptor} task
 * @returns {ClaudeWorkflowNodeKind}
 */
function classifyTask(task) {
    if (task.agent) return "agent";
    if (task.computeFn) return "compute";
    if (task.staticPayload !== undefined) return "static";
    if (task.meta?.__timer) return "timer";
    if (task.waitAsync || task.meta?.__waitForEvent) return "wait";
    if (task.meta?.__subflow) return "subflow";
    if (task.meta?.__sandbox) return "sandbox";
    if (task.needsApproval) return "approval";
    return "unknown";
}
