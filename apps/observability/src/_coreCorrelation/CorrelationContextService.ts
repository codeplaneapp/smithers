import { Context, Effect } from "effect";
import type { CorrelationContext } from "./CorrelationContext.ts";
import type { CorrelationPatch } from "./CorrelationPatch.ts";
declare const CorrelationContextService_base: Context.TagClass<CorrelationContextService, "CorrelationContextService", {
    readonly current: () => Effect.Effect<CorrelationContext | undefined>;
    readonly withCorrelation: <A, E, R>(patch: CorrelationPatch, effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
    readonly toLogAnnotations: (context?: CorrelationContext | null) => Record<string, unknown> | undefined;
}>;
export declare class CorrelationContextService extends CorrelationContextService_base {
}
export {};
