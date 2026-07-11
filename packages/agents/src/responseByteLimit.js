import { HttpClientPolicyError } from "@smithers-orchestrator/http-client";

/**
 * Resolve a configurable response-body cap before a request is dispatched.
 * The shared response reader enforces the same shape, but validating here
 * prevents an invalid local option from causing network side effects first.
 *
 * @param {unknown} value
 * @param {number} fallback
 * @param {string} [option]
 * @returns {number}
 */
export function responseByteLimit(value, fallback, option = "maxResponseBytes") {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || /** @type {number} */ (resolved) < 0) {
    throw new HttpClientPolicyError(
      "INVALID_OPTION",
      `${option} must be a non-negative safe integer.`,
      { option },
    );
  }
  return /** @type {number} */ (resolved);
}
