import { Effect } from "effect";
import type * as Tracer from "effect/Tracer";
export declare function withSmithersSpan<A, E, R>(name: string, effect: Effect.Effect<A, E, R>, attributes?: Readonly<Record<string, unknown>>, _options?: Omit<Tracer.SpanOptions, "attributes" | "kind"> & {
    readonly kind?: Tracer.SpanKind;
}): Effect.Effect<A, E, Exclude<R, Tracer.ParentSpan>>;
