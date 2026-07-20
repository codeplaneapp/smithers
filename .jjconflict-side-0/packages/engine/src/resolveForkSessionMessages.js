import { SmithersError } from "@smithers-orchestrator/errors/SmithersError";

/** @typedef {import("@smithers-orchestrator/db/adapter/AttemptRow").AttemptRow} AttemptRow */

/**
 * Strip the loop-scope suffix (`@@ralph=0,...`) from a node id to recover the
 * logical task id authored in JSX.
 * @param {string} nodeId
 * @returns {string}
 */
function logicalNodeId(nodeId) {
    const atIdx = nodeId.indexOf("@@");
    return atIdx === -1 ? nodeId : nodeId.slice(0, atIdx);
}

/**
 * Parse the persisted agent conversation out of an attempt's meta JSON.
 * @param {string | null | undefined} metaJson
 * @returns {unknown[] | null}
 */
function conversationFromMeta(metaJson) {
    if (typeof metaJson !== "string" || metaJson.length === 0) {
        return null;
    }
    let meta;
    try {
        meta = JSON.parse(metaJson);
    }
    catch {
        return null;
    }
    if (!meta || typeof meta !== "object") {
        return null;
    }
    const conversation = /** @type {{ agentConversation?: unknown }} */ (meta).agentConversation;
    if (!Array.isArray(conversation) || conversation.length === 0) {
        return null;
    }
    const usable = conversation.every((entry) => entry && typeof entry === "object");
    return usable ? conversation : null;
}

/**
 * Sort key for picking the most recently completed attempt. Prefer
 * finishedAtMs, fall back to startedAtMs, then attempt number.
 * @param {AttemptRow} attempt
 * @returns {number}
 */
function completionOrder(attempt) {
    if (typeof attempt.finishedAtMs === "number")
        return attempt.finishedAtMs;
    if (typeof attempt.startedAtMs === "number")
        return attempt.startedAtMs;
    return attempt.attempt ?? 0;
}

/**
 * Resolve the agent session snapshot to seed a forked task from. Scans every
 * attempt of the run for finished executions of the fork source (matched by
 * logical id, so a source inside a loop resolves to its latest completed
 * iteration) and returns a deep copy of the most recent usable conversation.
 *
 * The copy guarantees the source session is never mutated by the fork.
 *
 * @param {readonly AttemptRow[]} attempts All attempts for the run.
 * @param {string} forkSource Logical id of the fork source task.
 * @param {string} nodeId Logical/scoped id of the forking task (for errors).
 * @returns {unknown[]} A fresh copy of the source conversation messages.
 */
export function resolveForkSessionMessages(attempts, forkSource, nodeId) {
    const finished = attempts.filter((attempt) => logicalNodeId(attempt.nodeId) === forkSource &&
        attempt.state === "finished");
    if (finished.length === 0) {
        throw new SmithersError("TASK_FORK_SOURCE_NOT_COMPLETE", `Task "${nodeId}" forks "${forkSource}", which has not completed.`, { nodeId, forkSource });
    }
    const ordered = [...finished].sort((a, b) => completionOrder(b) - completionOrder(a));
    for (const attempt of ordered) {
        const conversation = conversationFromMeta(attempt.metaJson);
        if (conversation) {
            return /** @type {unknown[]} */ (JSON.parse(JSON.stringify(conversation)));
        }
    }
    throw new SmithersError("TASK_FORK_SESSION_UNAVAILABLE", `Task "${nodeId}" forks "${forkSource}", which completed without a usable agent session snapshot.`, { nodeId, forkSource });
}
