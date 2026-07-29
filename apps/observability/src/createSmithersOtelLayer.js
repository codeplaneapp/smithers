import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as Otlp from "effect/unstable/observability/Otlp";
import { Fiber, Layer } from "effect";
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
    ...(resolved.headers && Object.keys(resolved.headers).length > 0 ? { headers: resolved.headers } : {}),
    resource: { serviceName: resolved.serviceName },
    tracerContext: (primitive, span) =>
      smithersTraceSpanStorage.run(span, () =>
        primitive["~effect/Effect/evaluate"](Fiber.getCurrent()),
      ),
  }).pipe(Layer.provide(FetchHttpClient.layer));
}
