import { getCurrentSmithersTraceSpan } from "./getCurrentSmithersTraceSpan.js";
/**
 * @returns {| Readonly<Record<string, string>> | undefined}
 */
export function getCurrentSmithersTraceAnnotations() {
    const span = getCurrentSmithersTraceSpan();
    if (!span) {
        return undefined;
    }
    return {
        traceId: span.traceId,
        spanId: span.spanId,
    };
}
