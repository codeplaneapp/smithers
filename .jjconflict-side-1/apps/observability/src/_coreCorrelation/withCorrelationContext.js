import { Effect } from "effect";
import { correlationContextFiberRef } from "./correlationContextFiberRef.js";
import { correlationStorage } from "./_correlationStorage.js";
import { mergeCorrelationContext } from "./mergeCorrelationContext.js";
/** @typedef {import("./CorrelationPatch.ts").CorrelationPatch} CorrelationPatch */

/**
 * Bridge the Effect-tracked correlation context onto the imperative
 * AsyncLocalStorage store so plain (non-Effect) `getCurrentCorrelationContext()`
 * reads — e.g. from the imperative logger — see the active run/node correlation
 * while the effect executes.
 *
 * IMPORTANT: run the resulting effect with `Effect.runPromise`/`runFork`, never
 * `Effect.runSync`. The acquire step calls `AsyncLocalStorage.enterWith()`, which
 * mutates the *caller's* async context. Under `runSync` the caller is whatever
 * synchronous context invoked it (e.g. a test-runner's root context); enabling
 * ALS async-hooks there leaks into every subsequent timer/promise on that
 * context. `runPromise`/`runFork` execute on an ephemeral fiber context, keeping
 * the enterWith scoped to that fiber.
 *
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
