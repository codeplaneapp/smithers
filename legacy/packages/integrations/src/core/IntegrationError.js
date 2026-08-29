import { SmithersError } from "@smthrs/errors/SmithersError";

/**
 * @typedef {"invalid-config" | "invalid-signature" | "unknown-source" | "decode-failed" | "poll-failed" | "delivery-failed" | "queue-full" | "queue-closed" | "credentials-missing" | "permission-denied" | "listener-conflict"} IntegrationErrorReason
 */

/**
 * Error raised by integration event sources and the delivery pipeline.
 * A `SmithersError` (code `INTEGRATION_ERROR`) with a machine-readable
 * `reason` so ingress code can map failures to HTTP statuses
 * (`invalid-signature` → 401, `unknown-source` → 404, ...).
 * `invalid-config` marks construction-time configuration errors that never
 * reach ingress.
 */
export class IntegrationError extends SmithersError {
  /** @type {IntegrationErrorReason} */
  reason;
  /**
   * @param {IntegrationErrorReason} reason
   * @param {string} message
   * @param {Record<string, unknown>} [details]
   * @param {{ cause?: unknown }} [options]
   */
  constructor(reason, message, details, options) {
    super("INTEGRATION_ERROR", message, { reason, ...details }, { cause: options?.cause, name: "IntegrationError" });
    this.reason = reason;
  }
}

/**
 * @param {unknown} error
 * @returns {error is IntegrationError}
 */
export function isIntegrationError(error) {
  return error instanceof IntegrationError || (error instanceof Error && error.name === "IntegrationError");
}
