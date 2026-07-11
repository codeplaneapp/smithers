/** @typedef {import("./types.ts").HttpClientPolicyErrorCode} HttpClientPolicyErrorCode */
/** @typedef {import("./types.ts").HttpClientPolicyErrorDetails} HttpClientPolicyErrorDetails */

/**
 * A deterministic policy/limit failure raised before unsafe outbound work can
 * continue. Messages deliberately omit URL query strings and userinfo.
 */
export class HttpClientPolicyError extends Error {
  /** @type {HttpClientPolicyErrorCode} */
  code;
  /** @type {HttpClientPolicyErrorDetails} */
  details;

  /**
   * @param {HttpClientPolicyErrorCode} code
   * @param {string} message
   * @param {HttpClientPolicyErrorDetails} [details]
   * @param {{ cause?: unknown }} [options]
   */
  constructor(code, message, details = {}, options = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "HttpClientPolicyError";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

/**
 * @param {unknown} value
 * @returns {value is HttpClientPolicyError}
 */
export function isHttpClientPolicyError(value) {
  return value instanceof HttpClientPolicyError ||
    (value instanceof Error && value.name === "HttpClientPolicyError" &&
      typeof /** @type {{ code?: unknown }} */ (value).code === "string");
}
