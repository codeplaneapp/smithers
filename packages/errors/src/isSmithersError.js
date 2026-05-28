import { isKnownSmithersErrorCode } from "./isKnownSmithersErrorCode.js";
import { SmithersError } from "./SmithersError.js";
/** @typedef {import("./SmithersError.js").SmithersError} SmithersError */
/**
 * @param {unknown} value
 * @returns {value is SmithersError}
 */
export function isSmithersError(value) {
    if (value instanceof SmithersError) {
        return true;
    }
    return Boolean(value &&
        typeof value === "object" &&
        "code" in value &&
        typeof (/** @type {{ code?: unknown }} */ (value).code) === "string" &&
        isKnownSmithersErrorCode(/** @type {{ code: string }} */ (value).code) &&
        "message" in value);
}
