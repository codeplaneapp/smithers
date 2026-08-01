import { Effect } from "effect";
import { correlationContextFiberRef } from "./correlationContextFiberRef.js";
import { correlationStorage } from "./_correlationStorage.js";
/** @typedef {import("./CorrelationContext.ts").CorrelationContext} CorrelationContext */

/**
 * @returns {Effect.Effect< CorrelationContext | undefined >}
 */
export function getCurrentCorrelationContextEffect() {
  return correlationContextFiberRef.pipe(Effect.map((fiberContext) => fiberContext ?? correlationStorage.getStore()));
}
