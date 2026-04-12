import { smithersTraceSpanStorage } from "./_smithersTraceSpanStorage.js";
/**
 * @returns {Tracer.AnySpan | undefined}
 */
export function getCurrentSmithersTraceSpan() {
    return smithersTraceSpanStorage.getStore();
}
