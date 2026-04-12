import type { CorrelationContext } from "./CorrelationContext.ts";
import type { CorrelationPatch } from "./CorrelationPatch.ts";
export declare function mergeCorrelationContext(base?: CorrelationContext | null, patch?: CorrelationPatch): CorrelationContext | undefined;
