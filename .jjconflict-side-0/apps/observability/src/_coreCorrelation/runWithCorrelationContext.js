import { correlationStorage } from "./_correlationStorage.js";
import { mergeCorrelationContext } from "./mergeCorrelationContext.js";
/** @typedef {import("./CorrelationPatch.ts").CorrelationPatch} CorrelationPatch */

/**
 * @template T
 * @param {CorrelationPatch} patch
 * @param {() => T} fn
 * @returns {T}
 */
export function runWithCorrelationContext(patch, fn) {
    const next = mergeCorrelationContext(correlationStorage.getStore(), patch);
    return next ? correlationStorage.run(next, fn) : fn();
}
