import { Context, Effect, Layer } from "effect";
import type { CorrelationPatch } from "./_coreCorrelation/index.ts";
export type SmithersLogFormat = "json" | "pretty" | "string" | "logfmt";
export declare const prometheusContentType = "text/plain; version=0.0.4; charset=utf-8";
export declare const smithersSpanNames: {
    readonly run: "smithers.run";
    readonly task: "smithers.task";
    readonly agent: "smithers.agent";
    readonly tool: "smithers.tool";
};
export type SmithersSpanAttributesInput = Readonly<Record<string, unknown>>;
declare const TracingService_base: Context.TagClass<TracingService, "TracingService", {
    readonly withSpan: <A, E, R>(name: string, effect: Effect.Effect<A, E, R>, attributes?: Record<string, unknown>) => Effect.Effect<A, E, R>;
    readonly annotate: (attributes: Record<string, unknown>) => Effect.Effect<void>;
    readonly withCorrelation: <A, E, R>(context: CorrelationPatch, effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
}>;
export declare class TracingService extends TracingService_base {
}
export declare function getCurrentSmithersTraceAnnotations(): Readonly<Record<string, string>> | undefined;
export declare function makeSmithersSpanAttributes(attributes?: SmithersSpanAttributesInput): Record<string, unknown>;
export declare function annotateSmithersTrace(attributes?: SmithersSpanAttributesInput): Effect.Effect<void>;
export declare function withSmithersSpan<A, E, R>(name: string, effect: Effect.Effect<A, E, R>, attributes?: SmithersSpanAttributesInput): Effect.Effect<A, E, R>;
export declare const TracingServiceLive: Layer.Layer<TracingService, never, never>;
export {};
