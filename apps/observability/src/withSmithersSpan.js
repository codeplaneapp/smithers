import { TracingService, withSmithersSpan as withCoreSmithersSpan, } from "./_coreTracing.js";
import { Effect } from "effect";
/**
 * @template A, E, R
 * @param {string} name
 * @param {Effect.Effect<A, E, R>} effect
 * @param {Readonly<Record<string, unknown>>} [attributes]
 * @param {Omit<Tracer.SpanOptions, "attributes" | "kind"> & { readonly kind?: Tracer.SpanKind; }} [_options]
 * @returns {Effect.Effect<A, E, Exclude<R, Tracer.ParentSpan>>}
 */
export function withSmithersSpan(name, effect, attributes, _options) {
    return Effect.flatMap(Effect.serviceOption(TracingService), (service) => service._tag === "Some"
        ? service.value.withSpan(name, effect, attributes ? { ...attributes } : undefined)
        : withCoreSmithersSpan(name, effect, attributes));
}
