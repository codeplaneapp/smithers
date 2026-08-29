import { SmithersError } from "./SmithersError.js";
/**
 * @param {unknown} value
 * @returns {value is import("./SmithersError.js").SmithersError}
 */
export function isSmithersError(value) {
  return value instanceof SmithersError;
}
