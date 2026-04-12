import { TracingService, annotateSmithersTrace as annotateCoreSmithersTrace, } from "./_coreTracing.js";
import { Effect } from "effect";
/**
 * @param {Readonly<Record<string, unknown>>} [attributes]
 * @returns {Effect.Effect<void>}
 */
export function annotateSmithersTrace(attributes = {}) {
    return Effect.flatMap(Effect.serviceOption(TracingService), (service) => service._tag === "Some"
        ? service.value.annotate({ ...attributes })
        : annotateCoreSmithersTrace(attributes));
}
