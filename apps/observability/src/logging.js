import { Effect } from "effect";
import { getCurrentSmithersTraceAnnotations } from "./getCurrentSmithersTraceAnnotations.js";
import { correlationContextToLogAnnotations, getCurrentCorrelationContext, withCurrentCorrelationContext, } from "./correlation.js";
/**
 * @typedef {Record<string, unknown> | undefined} LogAnnotations
 */

/**
 * @param {Effect.Effect<void, never, never>} effect
 * @param {LogAnnotations} [annotations]
 * @param {string} [span]
 */
function emitLog(effect, annotations, span) {
    const correlationAnnotations = correlationContextToLogAnnotations(getCurrentCorrelationContext());
    const traceAnnotations = getCurrentSmithersTraceAnnotations();
    const mergedAnnotations = correlationAnnotations || traceAnnotations || annotations
        ? {
            ...correlationAnnotations,
            ...traceAnnotations,
            ...annotations,
        }
        : undefined;
    let program = effect;
    if (mergedAnnotations) {
        program = program.pipe(Effect.annotateLogs(mergedAnnotations));
    }
    if (span) {
        program = program.pipe(Effect.withLogSpan(span));
    }
    void Effect.runFork(withCurrentCorrelationContext(program));
}
/**
 * @param {string} message
 * @param {LogAnnotations} [annotations]
 * @param {string} [span]
 */
export function logDebug(message, annotations, span) {
    emitLog(Effect.logDebug(message), annotations, span);
}
/**
 * @param {string} message
 * @param {LogAnnotations} [annotations]
 * @param {string} [span]
 */
export function logInfo(message, annotations, span) {
    emitLog(Effect.logInfo(message), annotations, span);
}
/**
 * @param {string} message
 * @param {LogAnnotations} [annotations]
 * @param {string} [span]
 */
export function logWarning(message, annotations, span) {
    emitLog(Effect.logWarning(message), annotations, span);
}
/**
 * @param {string} message
 * @param {LogAnnotations} [annotations]
 * @param {string} [span]
 */
export function logError(message, annotations, span) {
    emitLog(Effect.logError(message), annotations, span);
}
