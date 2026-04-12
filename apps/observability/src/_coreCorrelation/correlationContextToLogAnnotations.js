
/** @typedef {import("./CorrelationContext.ts").CorrelationContext} CorrelationContext */
/**
 * @param {CorrelationContext | null} [context]
 * @returns {Record<string, unknown> | undefined}
 */
export function correlationContextToLogAnnotations(context) {
    if (!context)
        return undefined;
    const annotations = {};
    if (context.runId)
        annotations.runId = context.runId;
    if (context.nodeId)
        annotations.nodeId = context.nodeId;
    if (context.workflowName)
        annotations.workflowName = context.workflowName;
    if (context.parentRunId)
        annotations.parentRunId = context.parentRunId;
    if (context.traceId)
        annotations.traceId = context.traceId;
    if (context.spanId)
        annotations.spanId = context.spanId;
    if (typeof context.iteration === "number")
        annotations.iteration = context.iteration;
    if (typeof context.attempt === "number")
        annotations.attempt = context.attempt;
    return Object.keys(annotations).length > 0 ? annotations : undefined;
}
