/** @typedef {import("./ClaudeWorkflowPhasePlan.ts").ClaudeWorkflowPhasePlan} ClaudeWorkflowPhasePlan */

import { buildClaudeWorkflowPhasePlan } from "./buildClaudeWorkflowPhasePlan.js";
import { parseXmlJson } from "./utils/xml.js";

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
export function deriveClaudeWorkflowPhasesFromFrame(frame, options = {}) {
    /** @type {XmlNodeOrNull} */
    let xml = null;
    if (typeof frame.xmlJson === "string" && frame.xmlJson.length > 0 && frame.xmlJson !== "null") {
        try {
            xml = parseXmlJson(frame.xmlJson);
        }
        catch {
            xml = null;
        }
    }
    /** @type {Array<{ nodeId: string; ordinal: number; iteration: number; kind: string }>} */
    let index = [];
    if (typeof frame.taskIndexJson === "string" && frame.taskIndexJson.length > 0) {
        try {
            const parsed = JSON.parse(frame.taskIndexJson);
            if (Array.isArray(parsed)) {
                index = parsed.filter((row) => row && typeof row === "object" && typeof row.nodeId === "string");
            }
        }
        catch {
            index = [];
        }
    }
    const labels = options.labels ?? {};
    const tasks = index.map((row) => ({
        nodeId: row.nodeId,
        label: labels[row.nodeId] || row.nodeId,
        ordinal: typeof row.ordinal === "number" ? row.ordinal : 0,
        kind: typeof row.kind === "string" && row.kind.length > 0 ? row.kind : "unknown",
    }));
    return buildClaudeWorkflowPhasePlan(xml, tasks, { collapsePhases: options.collapsePhases });
}

/** @typedef {import("./XmlNode.ts").XmlNode | null} XmlNodeOrNull */
