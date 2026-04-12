import { Effect, FiberRef } from "effect";
import { correlationContextFiberRef } from "./correlationContextFiberRef.js";
import { getCurrentCorrelationContextEffect } from "./getCurrentCorrelationContextEffect.js";
import { mergeCorrelationContext } from "./mergeCorrelationContext.js";
/** @typedef {import("./CorrelationContext.ts").CorrelationContext} CorrelationContext */
/** @typedef {import("./CorrelationPatch.ts").CorrelationPatch} CorrelationPatch */

/**
 * @param {CorrelationPatch} patch
 * @returns {Effect.Effect<CorrelationContext | undefined>}
 */
export function updateCurrentCorrelationContext(patch) {
    return Effect.gen(function* () {
        const current = yield* getCurrentCorrelationContextEffect();
        const next = mergeCorrelationContext(current, patch);
        yield* FiberRef.set(correlationContextFiberRef, next);
        return next;
    });
}
