import { Effect } from "effect";
import { correlationContextFiberRef } from "./correlationContextFiberRef.js";
import { correlationStorage } from "./_correlationStorage.js";
import { mergeCorrelationContext } from "./mergeCorrelationContext.js";
/** @typedef {import("./CorrelationPatch.ts").CorrelationPatch} CorrelationPatch */

/**
 * @template A, E, R
 * @param {Effect.Effect<A, E, R>} effect
 * @param {CorrelationPatch} patch
 */
export function withCorrelationContext(effect, patch) {
    const next = mergeCorrelationContext(correlationStorage.getStore(), patch);
    if (!next)
        return effect;
    const located = effect.pipe(Effect.locally(correlationContextFiberRef, next));
    return Effect.acquireUseRelease(Effect.sync(() => {
        const previous = correlationStorage.getStore();
        correlationStorage.enterWith(next);
        return previous;
    }), () => located, (previous) => Effect.sync(() => correlationStorage.enterWith(previous)));
}
