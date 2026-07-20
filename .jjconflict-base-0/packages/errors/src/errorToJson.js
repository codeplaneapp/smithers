import { EngineError } from "./EngineError.js";
import { SmithersError } from "./SmithersError.js";
import { fromTaggedError } from "./fromTaggedError.js";
/**
 * Deeply convert a value into a structure that `JSON.stringify` can never throw
 * on. `errorToJson` output is fed straight into `JSON.stringify` on the engine's
 * durable failed-task write path, so a circular `cause`, a `BigInt` detail, or a
 * throwing getter must not be able to crash the error-recording code.
 *
 * @param {unknown} value
 * @param {WeakSet<object>} seen
 * @returns {unknown}
 */
function toJsonSafe(value, seen) {
    if (value === null)
        return null;
    const type = typeof value;
    if (type === "string" || type === "boolean")
        return value;
    if (type === "number")
        return Number.isFinite(value) ? value : null;
    if (type === "bigint")
        return value.toString();
    if (type === "undefined" || type === "function" || type === "symbol")
        return undefined;
    // value is an object at this point.
    const obj = /** @type {object} */ (value);
    if (seen.has(obj))
        return "[Circular]";
    seen.add(obj);
    try {
        if (obj instanceof Error) {
            /** @type {Record<string, unknown>} */
            const out = {
                name: obj.name,
                message: obj.message,
                stack: obj.stack,
            };
            let cause;
            try {
                cause = obj.cause;
            }
            catch {
                cause = undefined;
            }
            if (cause !== undefined)
                out.cause = toJsonSafe(cause, seen);
            for (const key of Object.keys(obj)) {
                if (key in out)
                    continue;
                let raw;
                try {
                    raw = /** @type {Record<string, unknown>} */ (obj)[key];
                }
                catch {
                    continue;
                }
                const safe = toJsonSafe(raw, seen);
                if (safe !== undefined)
                    out[key] = safe;
            }
            return out;
        }
        if (Array.isArray(obj)) {
            return obj.map((item) => {
                const safe = toJsonSafe(item, seen);
                return safe === undefined ? null : safe;
            });
        }
        /** @type {Record<string, unknown>} */
        const out = {};
        for (const key of Object.keys(obj)) {
            let raw;
            try {
                raw = /** @type {Record<string, unknown>} */ (obj)[key];
            }
            catch {
                continue;
            }
            const safe = toJsonSafe(raw, seen);
            if (safe !== undefined)
                out[key] = safe;
        }
        return out;
    }
    finally {
        seen.delete(obj);
    }
}
/**
 * @param {unknown} error
 * @returns {Record<string, unknown>}
 */
export function errorToJson(error) {
    return /** @type {Record<string, unknown>} */ (toJsonSafe(buildErrorJson(error), new WeakSet()));
}
/**
 * @param {unknown} error
 * @returns {Record<string, unknown>}
 */
function buildErrorJson(error) {
    const taggedError = fromTaggedError(error);
    if (taggedError) {
        return buildErrorJson(taggedError);
    }
    if (error instanceof SmithersError) {
        return {
            name: error.name,
            code: error.code,
            message: error.message,
            stack: error.stack,
            cause: error.cause,
            summary: error.summary,
            docsUrl: error.docsUrl,
            details: error.details,
        };
    }
    if (error instanceof EngineError) {
        return {
            name: error.name,
            code: error.code,
            message: error.message,
            stack: error.stack,
            cause: error.cause,
            summary: error.message,
            details: error.context,
        };
    }
    if (error instanceof Error) {
        return error;
    }
    if (error && typeof error === "object") {
        if (Array.isArray(error)) {
            // An array passed through here would survive toJsonSafe as a
            // top-level array, breaking the Record<string, unknown> contract
            // the durable failed-task write path relies on.
            return {
                message: JSON.stringify(toJsonSafe(error, new WeakSet())),
                value: error,
            };
        }
        return error;
    }
    return { message: String(error) };
}
