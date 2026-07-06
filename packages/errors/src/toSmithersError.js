import { SmithersError } from "./SmithersError.js";
import { EngineError } from "./EngineError.js";
import { fromTaggedError } from "./fromTaggedError.js";
import { isSmithersError } from "./isSmithersError.js";
/** @typedef {import("./ErrorWrapOptions.ts").ErrorWrapOptions} ErrorWrapOptions */

/**
 * @param {unknown} cause
 * @returns {string}
 */
function causeSummary(cause) {
    if (cause instanceof EngineError) {
        return cause.message;
    }
    if (isSmithersError(cause)) {
        return typeof cause.summary === "string" ? cause.summary : cause.message;
    }
    if (cause instanceof Error) {
        // AggregateError (e.g. a Bun build failure) hides the real messages behind
        // a bare count like "2 errors building X". Expand the sub-errors so the
        // summary shows each message and line number instead of just a total.
        const subErrors = Array.isArray(/** @type {any} */ (cause).errors)
            ? /** @type {any[]} */ (/** @type {any} */ (cause).errors)
            : [];
        if (subErrors.length > 0) {
            const details = subErrors
                .map((sub) => {
                    const message = typeof sub?.message === "string" ? sub.message : String(sub);
                    const line = sub?.position?.line;
                    return typeof line === "number" ? `${message} (line ${line})` : message;
                })
                .join("; ");
            return details ? `${cause.message}: ${details}` : cause.message;
        }
        return cause.message;
    }
    return String(cause);
}
/**
 * @param {unknown} cause
 * @param {string} [label]
 * @param {ErrorWrapOptions} [options]
 * @returns {SmithersError}
 */
export function toSmithersError(cause, label, options = {}) {
    const taggedError = fromTaggedError(cause);
    const normalizedCause = taggedError ?? cause;
    const smithersCause = isSmithersError(normalizedCause);
    if (smithersCause &&
        !label &&
        !options.code &&
        !options.details) {
        return normalizedCause;
    }
    const code = options.code ??
        (smithersCause
            ? normalizedCause.code
            : normalizedCause instanceof EngineError
                ? normalizedCause.code
                : "INTERNAL_ERROR");
    const details = {
        ...(smithersCause ? normalizedCause.details : {}),
        ...(normalizedCause instanceof EngineError ? normalizedCause.context : {}),
        ...options.details,
    };
    if (label && details.operation === undefined) {
        details.operation = label;
    }
    const summary = label
        ? `${label}: ${causeSummary(normalizedCause)}`
        : causeSummary(normalizedCause);
    return new SmithersError(code, summary, Object.keys(details).length > 0 ? details : undefined, { cause: normalizedCause });
}
