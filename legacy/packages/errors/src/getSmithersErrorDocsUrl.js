import { ERROR_REFERENCE_URL } from "./ERROR_REFERENCE_URL.js";
/** @typedef {import("./SmithersErrorCode.ts").SmithersErrorCode} SmithersErrorCode */

/**
 * @param {SmithersErrorCode} _code
 * @returns {string}
 */
// `_code` is accepted but ignored: every code currently shares the single
// reference page; the parameter keeps the signature stable for future
// per-code anchors.
export function getSmithersErrorDocsUrl(_code) {
  return ERROR_REFERENCE_URL;
}
