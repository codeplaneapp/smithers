import { correlationStorage } from "./_correlationStorage.js";
/** @typedef {import("./CorrelationContext.ts").CorrelationContext} CorrelationContext */

/**
 * @returns {CorrelationContext | undefined}
 */
export function getCurrentCorrelationContext() {
    return correlationStorage.getStore();
}
