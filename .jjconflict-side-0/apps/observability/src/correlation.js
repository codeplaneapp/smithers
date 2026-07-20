import { getCurrentCorrelationContext as getCoreCurrentCorrelationContext, mergeCorrelationContext as mergeCoreCorrelationContext, } from "./_coreCorrelation/index.js";
/** @typedef {import("./_coreCorrelation/CorrelationContext.ts").CorrelationContext} CorrelationContext */
/** @typedef {import("./_coreCorrelation/CorrelationPatch.ts").CorrelationPatch} CorrelationPatch */
/** @typedef {CorrelationPatch} CorrelationContextPatch */

export { correlationContextFiberRef, correlationContextToLogAnnotations, CorrelationContextLive, CorrelationContextService, getCurrentCorrelationContext, getCurrentCorrelationContextEffect, mergeCorrelationContext, runWithCorrelationContext, withCorrelationContext, withCurrentCorrelationContext, } from "./_coreCorrelation/index.js";
/**
 * Temporary compatibility shim for legacy, non-Effect callers.
 *
 * Unlike the FiberRef-based core implementation
 * ({@link import("./_coreCorrelation/updateCurrentCorrelationContext.js").updateCurrentCorrelationContext}),
 * which returns an Effect and sets a fresh merged context on the
 * `correlationContextFiberRef`, this shim runs synchronously and applies the
 * patch by **mutating the current context object in place** via
 * `Object.assign(current, next)`. Any references already holding the current
 * context object will observe the mutation. This in-place semantics is
 * intentional and exists only to preserve behavior for callers that captured a
 * context reference before the Effect-based API existed.
 *
 * If there is no current context, the patch is a no-op (nothing is created).
 *
 * @deprecated Prefer the Effect-returning
 * `updateCurrentCorrelationContext` from
 * `@smithers-orchestrator/observability` (the `_coreCorrelation` version),
 * which does not mutate shared state. This shim will be removed once legacy
 * callers migrate.
 *
 * @param {CorrelationPatch} patch
 * @returns {void}
 */
export function updateCurrentCorrelationContext(patch) {
    const current = getCoreCurrentCorrelationContext();
    if (!current)
        return;
    // Compatibility shim: mutate the current context in place rather than
    // setting a new FiberRef value. See the JSDoc above — this preserves
    // behavior for legacy callers and is intentional, not a bug. Remove once
    // those callers adopt the Effect-returning core
    // updateCurrentCorrelationContext.
    const next = mergeCoreCorrelationContext(current, patch);
    if (!next)
        return;
    Object.assign(current, next);
}
