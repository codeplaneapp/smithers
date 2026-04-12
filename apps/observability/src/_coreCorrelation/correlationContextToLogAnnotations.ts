import type { CorrelationContext } from "./CorrelationContext.ts";
export declare function correlationContextToLogAnnotations(context?: CorrelationContext | null): Record<string, unknown> | undefined;
