// @smithers-type-exports-begin
/** @typedef {import("./correlation.ts").CorrelationContext} CorrelationContext */
/** @typedef {import("./correlation.ts").CorrelationContextPatch} CorrelationContextPatch */
// @smithers-type-exports-end

import { getCurrentCorrelationContext as getCoreCurrentCorrelationContext, mergeCorrelationContext as mergeCoreCorrelationContext, } from "./_coreCorrelation/index.js";
/** @typedef {import("./index.ts").index} index */

/** @typedef {import("./_coreCorrelation/index.ts").CorrelationPatch} CorrelationPatch */

export { correlationContextFiberRef, correlationContextToLogAnnotations, CorrelationContextLive, CorrelationContextService, getCurrentCorrelationContext, getCurrentCorrelationContextEffect, mergeCorrelationContext, runWithCorrelationContext, withCorrelationContext, withCurrentCorrelationContext, } from "./_coreCorrelation/index.js";
/**
 * @param {CorrelationPatch} patch
 */
export function updateCurrentCorrelationContext(patch) {
    const current = getCoreCurrentCorrelationContext();
    if (!current)
        return;
    // TODO: replace this compatibility shim once legacy callers adopt the
    // Effect-returning updateCurrentCorrelationContext from @smithers/observability.
    const next = mergeCoreCorrelationContext(current, patch);
    if (!next)
        return;
    Object.assign(current, next);
}
