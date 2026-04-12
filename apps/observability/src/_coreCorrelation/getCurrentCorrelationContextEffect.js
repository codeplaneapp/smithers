import { Effect, FiberRef } from "effect";
import { correlationContextFiberRef } from "./correlationContextFiberRef.js";
import { correlationStorage } from "./_correlationStorage.js";
/** @typedef {import("./CorrelationContext.ts").CorrelationContext} CorrelationContext */

/**
 * @returns {Effect.Effect< CorrelationContext | undefined >}
 */
export function getCurrentCorrelationContextEffect() {
    return FiberRef.get(correlationContextFiberRef).pipe(Effect.map((fiberContext) => fiberContext ?? correlationStorage.getStore()));
}
