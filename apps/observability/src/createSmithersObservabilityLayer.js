import * as BunContext from "@effect/platform-bun/BunServices";
import { TracingServiceLive } from "./_coreTracing.js";
import { Effect, Layer, Logger, References } from "effect";
import { SmithersObservability } from "./SmithersObservability.js";
import { resolveSmithersObservabilityOptions } from "./resolveSmithersObservabilityOptions.js";
import { createSmithersOtelLayer } from "./createSmithersOtelLayer.js";
import { MetricsServiceLive } from "./MetricsServiceLive.js";
import { annotateSmithersTrace } from "./annotateSmithersTrace.js";
import { withSmithersSpan } from "./withSmithersSpan.js";
/** @typedef {import("./ResolvedSmithersObservabilityOptions.ts").ResolvedSmithersObservabilityOptions} ResolvedSmithersObservabilityOptions */
/** @typedef {import("./SmithersLogFormat.ts").SmithersLogFormat} SmithersLogFormat */
/** @typedef {import("./SmithersObservabilityService.ts").SmithersObservabilityService} SmithersObservabilityService */

/** @typedef {import("./SmithersObservabilityOptions.ts").SmithersObservabilityOptions} SmithersObservabilityOptions */

/**
 * @param {SmithersLogFormat} format
 */
function resolveLogger(format) {
  switch (format) {
    case "json":
      return Logger.consoleJson;
    case "pretty":
      return Logger.consolePretty();
    case "string":
      return Logger.consolePretty({ colors: false });
    case "logfmt":
    default:
      return Logger.consoleLogFmt;
  }
}
/**
 * @param {ResolvedSmithersObservabilityOptions} options
 * @returns {SmithersObservabilityService}
 */
function makeService(options) {
  return {
    options,
    annotate: (attributes) => annotateSmithersTrace(attributes),
    withSpan: (name, effect, attributes) => withSmithersSpan(name, effect, attributes),
  };
}
/**
 * @param {SmithersObservabilityOptions} [options]
 */
export function createSmithersObservabilityLayer(options = {}) {
  const resolved = resolveSmithersObservabilityOptions(options);
  const loggerLayers = resolved.installLogger
    ? [
        Logger.layer([resolveLogger(resolved.logFormat)]),
        Layer.succeed(References.MinimumLogLevel, resolved.logLevel),
      ]
    : [];
  return Layer.mergeAll(
    BunContext.layer,
    ...loggerLayers,
    createSmithersOtelLayer(resolved),
    MetricsServiceLive,
    TracingServiceLive,
    Layer.succeed(SmithersObservability, makeService(resolved)),
  );
}
