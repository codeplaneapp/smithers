import type { CorrelationPatch } from "./_coreCorrelation/index.ts";
export type { CorrelationContext, CorrelationPatch, } from "./_coreCorrelation/index.ts";
export { correlationContextFiberRef, correlationContextToLogAnnotations, CorrelationContextLive, CorrelationContextService, getCurrentCorrelationContext, getCurrentCorrelationContextEffect, mergeCorrelationContext, runWithCorrelationContext, withCorrelationContext, withCurrentCorrelationContext, } from "./_coreCorrelation/index.ts";
export type CorrelationContextPatch = CorrelationPatch;
export declare function updateCurrentCorrelationContext(patch: CorrelationPatch): void;
