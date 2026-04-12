import type { CorrelationPatch } from "./CorrelationPatch.ts";
export declare function runWithCorrelationContext<T>(patch: CorrelationPatch, fn: () => T): T;
