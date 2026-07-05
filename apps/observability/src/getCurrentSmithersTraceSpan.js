import { smithersTraceSpanStorage } from "./_smithersTraceSpanStorage.js";
/**
 * @returns {import("effect/Tracer").AnySpan | undefined}
 */
export function getCurrentSmithersTraceSpan() {
    return smithersTraceSpanStorage.getStore();
}
