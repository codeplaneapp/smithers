import { getTableColumns } from "drizzle-orm/utils";
/** @typedef {import("drizzle-orm").Table} Table */

/**
 * @param {Table} table
 * @param {string} runId
 * @param {string} nodeId
 * @param {number} iteration
 * @param {unknown} payload
 */
export function buildOutputRow(table, runId, nodeId, iteration, payload) {
    const cols = getTableColumns(table);
    const keys = Object.keys(cols);
    const hasPayload = keys.includes("payload");
    const payloadOnly = hasPayload &&
        keys.every((key) => key === "runId" ||
            key === "nodeId" ||
            key === "iteration" ||
            key === "payload");
    if (payloadOnly) {
        return {
            runId,
            nodeId,
            iteration,
            payload: (payload ?? null),
        };
    }
    return {
        ...(payload ?? {}),
        runId,
        nodeId,
        iteration,
    };
}
