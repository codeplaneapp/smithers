import * as FetchHttpClient from "@effect/platform/FetchHttpClient";
import * as Otlp from "@effect/opentelemetry/Otlp";
import { Layer } from "effect";
import { smithersTraceSpanStorage } from "./_smithersTraceSpanStorage.js";
import { resolveSmithersObservabilityOptions } from "./resolveSmithersObservabilityOptions.js";
/** @typedef {import("./SmithersObservabilityOptions.ts").SmithersObservabilityOptions} SmithersObservabilityOptions */

/**
 * @param {SmithersObservabilityOptions} [options]
 */
export function createSmithersOtelLayer(options = {}) {
    const resolved = resolveSmithersObservabilityOptions(options);
    if (!resolved.enabled) {
        return Layer.empty;
    }
    return Otlp.layerJson({
        baseUrl: resolved.endpoint,
        resource: { serviceName: resolved.serviceName },
        tracerContext: (execute, span) => smithersTraceSpanStorage.run(span, execute),
    }).pipe(Layer.provide(FetchHttpClient.layer));
}
