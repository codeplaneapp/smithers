
/** @typedef {import("./CorrelationContext.ts").CorrelationContext} CorrelationContext */
/** @typedef {import("./CorrelationPatch.ts").CorrelationPatch} CorrelationPatch */
/**
 * @param {unknown} value
 * @returns {string | undefined}
 */
function cleanString(value) {
    return typeof value === "string" && value.length > 0 ? value : undefined;
}
/**
 * @param {unknown} value
 * @returns {number | undefined}
 */
function cleanNumber(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
/**
 * @param {CorrelationPatch} patch
 * @returns {Partial<CorrelationContext> | undefined}
 */
function normalizePatch(patch) {
    if (!patch)
        return undefined;
    const normalized = {};
    const runId = cleanString(patch.runId);
    const nodeId = cleanString(patch.nodeId);
    const workflowName = cleanString(patch.workflowName);
    const parentRunId = cleanString(patch.parentRunId);
    const traceId = cleanString(patch.traceId);
    const spanId = cleanString(patch.spanId);
    const iteration = cleanNumber(patch.iteration);
    const attempt = cleanNumber(patch.attempt);
    if (runId)
        normalized.runId = runId;
    if (nodeId)
        normalized.nodeId = nodeId;
    if (workflowName)
        normalized.workflowName = workflowName;
    if (parentRunId)
        normalized.parentRunId = parentRunId;
    if (traceId)
        normalized.traceId = traceId;
    if (spanId)
        normalized.spanId = spanId;
    if (iteration !== undefined)
        normalized.iteration = iteration;
    if (attempt !== undefined)
        normalized.attempt = attempt;
    return Object.keys(normalized).length > 0 ? normalized : undefined;
}
/**
 * @param {CorrelationContext | null} [base]
 * @param {CorrelationPatch} [patch]
 * @returns {CorrelationContext | undefined}
 */
export function mergeCorrelationContext(base, patch) {
    const normalizedPatch = normalizePatch(patch);
    const merged = { ...base, ...normalizedPatch };
    return merged.runId ? merged : undefined;
}
