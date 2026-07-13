import { SmithersError } from '@smithers-orchestrator/errors/SmithersError';

/**
 * @param {unknown} error
 * @returns {error is IntegrationError}
 */
declare function isIntegrationError(error: unknown): error is IntegrationError;
/**
 * @typedef {"invalid-signature" | "unknown-source" | "decode-failed" | "poll-failed" | "delivery-failed" | "queue-full" | "queue-closed"} IntegrationErrorReason
 */
/**
 * Error raised by integration event sources and the delivery pipeline.
 * A `SmithersError` (code `INTEGRATION_ERROR`) with a machine-readable
 * `reason` so ingress code can map failures to HTTP statuses
 * (`invalid-signature` → 401, `unknown-source` → 404, ...).
 */
declare class IntegrationError extends SmithersError {
    /**
   * @param {IntegrationErrorReason} reason
   * @param {string} message
   * @param {Record<string, unknown>} [details]
   * @param {{ cause?: unknown }} [options]
   */
    constructor(reason: IntegrationErrorReason, message: string, details?: Record<string, unknown>, options?: {
        cause?: unknown;
    });
    /** @type {IntegrationErrorReason} */
    reason: IntegrationErrorReason;
}
type IntegrationErrorReason = "invalid-signature" | "unknown-source" | "decode-failed" | "poll-failed" | "delivery-failed" | "queue-full" | "queue-closed";

export { IntegrationError, type IntegrationErrorReason, isIntegrationError };
