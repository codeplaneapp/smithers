import { nowMs } from "@smithers-orchestrator/scheduler/nowMs";

/**
 * @typedef {import("@smithers-orchestrator/graph/TaskDescriptor").TaskDescriptor} TaskDescriptor
 */

/**
 * @param {TaskDescriptor["cachePolicy"]} policy
 * @returns {"run" | "workflow" | "global"}
 */
export function normalizeCacheScope(policy) {
    return policy?.scope === "run" || policy?.scope === "global"
        ? policy.scope
        : "workflow";
}

/**
 * @param {"run" | "workflow" | "global"} scope
 * @param {string} runId
 * @param {string} workflowName
 * @param {TaskDescriptor} desc
 * @returns {Record<string, unknown>}
 */
export function buildCacheScopeIdentity(scope, runId, workflowName, desc) {
    const taskKey = desc.cachePolicy?.key ?? desc.nodeId;
    const identity = {
        taskKey,
        outputTableName: desc.outputTableName,
    };
    if (scope === "global") {
        return identity;
    }
    if (scope === "run") {
        return { runId, workflowName, ...identity };
    }
    return { workflowName, ...identity };
}

/**
 * @param {unknown} row
 * @param {TaskDescriptor["cachePolicy"]} policy
 * @returns {boolean}
 */
export function isFreshCacheRow(row, policy) {
    const ttlMs = policy?.ttlMs;
    if (ttlMs === undefined || ttlMs === null) {
        return true;
    }
    if (typeof ttlMs !== "number" || !Number.isFinite(ttlMs) || ttlMs < 0) {
        return false;
    }
    const createdAtMs = /** @type {{ createdAtMs?: unknown }} */ (row)?.createdAtMs;
    return typeof createdAtMs === "number" && nowMs() - createdAtMs <= ttlMs;
}
