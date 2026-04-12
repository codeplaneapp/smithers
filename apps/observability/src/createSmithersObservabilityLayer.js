import * as BunContext from "@effect/platform-bun/BunContext";
import { TracingServiceLive } from "./_coreTracing.js";
import { Effect, Layer, Logger } from "effect";
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
            return Logger.withLeveledConsole(Logger.jsonLogger);
        case "pretty":
            return Logger.prettyLogger();
        case "string":
            return Logger.withLeveledConsole(Logger.stringLogger);
        case "logfmt":
        default:
            return Logger.withLeveledConsole(Logger.logfmtLogger);
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
    return Layer.mergeAll(BunContext.layer, Logger.replace(Logger.defaultLogger, resolveLogger(resolved.logFormat)), Logger.minimumLogLevel(resolved.logLevel), createSmithersOtelLayer(resolved), MetricsServiceLive, TracingServiceLive, Layer.succeed(SmithersObservability, makeService(resolved)));
}
