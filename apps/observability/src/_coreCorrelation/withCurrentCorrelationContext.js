import { Effect } from "effect";
import { correlationContextFiberRef } from "./correlationContextFiberRef.js";
import { correlationStorage } from "./_correlationStorage.js";
/**
 * @template A, E, R
 * @param {Effect.Effect<A, E, R>} effect
 */
export function withCurrentCorrelationContext(effect) {
    const current = correlationStorage.getStore();
    return current
        ? effect.pipe(Effect.locally(correlationContextFiberRef, current))
        : effect;
}
