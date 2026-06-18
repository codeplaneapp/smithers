import { SmithersError } from "./SmithersError.js";
/** @typedef {import("./SmithersError.js").SmithersError} SmithersError */
/**
 * @param {unknown} value
 * @returns {value is SmithersError}
 */
export function isSmithersError(value) {
    return value instanceof SmithersError;
}
