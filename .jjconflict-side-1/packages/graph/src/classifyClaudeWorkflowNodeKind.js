/** @typedef {import("./TaskDescriptor.ts").TaskDescriptor} TaskDescriptor */
/** @typedef {import("./ClaudeWorkflowNodePhase.ts").ClaudeWorkflowNodeKind} ClaudeWorkflowNodeKind */

/**
 * Classify a task descriptor into the Claude Code /workflows node kind.
 *
 * Shared by the live derivation (`deriveClaudeWorkflowPhases`, over a
 * GraphSnapshot) and the engine's frame persistence (`persistDriverFrame`
 * stamps this onto the frame task index) so that the persisted `kind` a LIVE
 * run reads back via `deriveClaudeWorkflowPhasesFromFrame` matches the live
 * classification for every node type — including timer/wait/subflow/sandbox and
 * a childless approval gate, which `task.kind` alone does not capture.
 *
 * @param {TaskDescriptor} task
 * @returns {ClaudeWorkflowNodeKind}
 */
export function classifyClaudeWorkflowNodeKind(task) {
    // A HumanTask carries both a computeFn and needsApproval, so the field
    // checks below would misclassify it as "compute". The persisted descriptor
    // kind preserves the human classification (see extract.js), so trust it here.
    if (task.kind === "human") return "human";
    if (task.agent) return "agent";
    if (task.meta?.__subflow) return "subflow";
    if (task.meta?.__sandbox) return "sandbox";
    if (task.computeFn) return "compute";
    if (task.staticPayload !== undefined) return "static";
    if (task.meta?.__timer) return "timer";
    if (task.waitAsync || task.meta?.__waitForEvent) return "wait";
    if (task.needsApproval) return "approval";
    return "unknown";
}
