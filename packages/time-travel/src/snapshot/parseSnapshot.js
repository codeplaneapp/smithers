import { parseSnapshotJson } from "./parseSnapshotJson.js";
import { SmithersError } from "@smithers-orchestrator/errors/SmithersError";
/** @typedef {import("../ParsedSnapshot.ts").ParsedSnapshot} ParsedSnapshot */
/** @typedef {import("./Snapshot.ts").Snapshot} Snapshot */

/**
 * @param {string} field
 * @param {string} message
 * @param {{ runId?: string; frameNo?: number }} context
 * @returns {SmithersError}
 */
function corruptSnapshotShape(field, message, context) {
    return new SmithersError(
        "DB_QUERY_FAILED",
        `Corrupt snapshot data: ${field} ${message}`,
        { field, ...context },
    );
}

/**
 * @param {string} json
 * @param {string} field
 * @param {{ runId?: string; frameNo?: number }} context
 * @returns {unknown[]}
 */
function parseSnapshotArray(json, field, context) {
    const value = parseSnapshotJson(json, field, context);
    if (!Array.isArray(value)) {
        throw corruptSnapshotShape(field, "must be an array", context);
    }
    return value;
}

/**
 * @param {string} json
 * @param {string} field
 * @param {{ runId?: string; frameNo?: number }} context
 * @returns {Record<string, unknown>}
 */
function parseSnapshotRecord(json, field, context) {
    const value = parseSnapshotJson(json, field, context);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw corruptSnapshotShape(field, "must be an object", context);
    }
    return /** @type {Record<string, unknown>} */ (value);
}

/**
 * @param {unknown} value
 * @param {string} field
 * @param {number} index
 * @param {{ runId?: string; frameNo?: number }} context
 * @returns {Record<string, unknown>}
 */
function assertSnapshotRecordItem(value, field, index, context) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw corruptSnapshotShape(field, `entry ${index} must be an object`, context);
    }
    return /** @type {Record<string, unknown>} */ (value);
}

/**
 * @param {Snapshot} snapshot
 * @returns {ParsedSnapshot}
 */
export function parseSnapshot(snapshot) {
    const ctx = { runId: snapshot.runId, frameNo: snapshot.frameNo };
    const nodesArr = parseSnapshotArray(snapshot.nodesJson, "nodesJson", ctx);
    const nodes = {};
    for (const [index, value] of nodesArr.entries()) {
        const n = assertSnapshotRecordItem(value, "nodesJson", index, ctx);
        if (typeof n.nodeId !== "string" || typeof n.iteration !== "number") {
            throw corruptSnapshotShape("nodesJson", `entry ${index} must include nodeId and numeric iteration`, ctx);
        }
        nodes[`${n.nodeId}::${n.iteration}`] = n;
    }
    const ralphArr = parseSnapshotArray(snapshot.ralphJson, "ralphJson", ctx);
    const ralph = {};
    for (const [index, value] of ralphArr.entries()) {
        const r = assertSnapshotRecordItem(value, "ralphJson", index, ctx);
        if (typeof r.ralphId !== "string") {
            throw corruptSnapshotShape("ralphJson", `entry ${index} must include ralphId`, ctx);
        }
        ralph[r.ralphId] = r;
    }
    return {
        runId: snapshot.runId,
        frameNo: snapshot.frameNo,
        nodes,
        outputs: parseSnapshotRecord(snapshot.outputsJson, "outputsJson", ctx),
        ralph,
        input: parseSnapshotRecord(snapshot.inputJson, "inputJson", ctx),
        vcsPointer: snapshot.vcsPointer,
        workflowHash: snapshot.workflowHash,
        contentHash: snapshot.contentHash,
        createdAtMs: snapshot.createdAtMs,
    };
}
