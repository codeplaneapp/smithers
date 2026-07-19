/**
 * @param {unknown} payload
 */
export function stripAutoColumns(payload) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        return payload;
    }
    const {
        runId: _runId,
        nodeId: _nodeId,
        iteration: _iteration,
        __smithersProvenanceSeq: _provenanceSeq,
        ...rest
    } = payload;
    return rest;
}
