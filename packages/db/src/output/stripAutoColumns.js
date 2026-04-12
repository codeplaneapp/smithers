/**
 * @param {unknown} payload
 */
export function stripAutoColumns(payload) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        return payload;
    }
    const { runId: _runId, nodeId: _nodeId, iteration: _iteration, ...rest } = payload;
    return rest;
}
