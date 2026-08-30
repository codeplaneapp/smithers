/**
 * Provider error classification.
 *
 * Every integration failure is one `IntegrationError` carrying a
 * machine-readable {@link Reason}. A caller maps the reason to whatever its
 * transport needs, `invalid-signature` to 401 and `permission-denied` to 403,
 * without reading message text, and the control plane maps it to a typed
 * `ControlError` at the channel boundary.
 *
 * Details are provider-safe by construction: no constructor in this package
 * ever puts a token, an API key, or a webhook secret into `details`.
 *
 * @since 1.0.0
 */
import { InvalidInput, Unauthorized } from "@smthrs/control/ControlError"
import { SmithersError } from "@smthrs/errors/SmithersError"

/**
 * Every classification an integration failure can carry, in one runtime list.
 *
 * {@link Reason} is derived from it and `core/ActionFailure.ts` builds the
 * action-boundary schema from it, so adding a reason is a single edit and the
 * durable error schema cannot drift from the class.
 *
 * @category models
 * @since 1.0.0
 */
export const reasons = [
  "invalid-config",
  "invalid-signature",
  "decode-failed",
  "poll-failed",
  "delivery-failed",
  "credentials-missing",
  "permission-denied",
  "listener-conflict"
] as const

/**
 * What went wrong, coarsely enough for a caller to act on.
 *
 * @category models
 * @since 1.0.0
 */
export type Reason = typeof reasons[number]

/**
 * A failure raised by an integration client, webhook source, or listener
 * reconciliation.
 *
 * @category errors
 * @since 1.0.0
 */
export class IntegrationError extends SmithersError {
  /** The machine-readable classification. */
  readonly reason: Reason

  constructor(
    reason: Reason,
    message: string,
    details?: Record<string, unknown>,
    options?: { readonly cause?: unknown }
  ) {
    super("INTEGRATION_ERROR", message, { reason, ...details }, {
      cause: options?.cause,
      name: "IntegrationError"
    })
    this.reason = reason
  }
}

/**
 * Whether `error` is an {@link IntegrationError}.
 *
 * The name check catches an error that crossed a module-instance boundary,
 * where `instanceof` alone would miss it.
 *
 * @category refinements
 * @since 1.0.0
 */
export const isIntegrationError = (error: unknown): error is IntegrationError =>
  error instanceof IntegrationError || (error instanceof Error && error.name === "IntegrationError")

/**
 * Whether the failure is worth another attempt. Set by the clients on the
 * responses that a retry can plausibly clear.
 *
 * @category refinements
 * @since 1.0.0
 */
export const isRetryable = (error: unknown): boolean =>
  isIntegrationError(error) && error.details?.["retryable"] === true

/**
 * Maps a failure onto the control plane's `Unauthorized`.
 *
 * Only the reason reaches the control plane. A verifier that leaked which
 * byte of a digest mismatched would be a verification oracle.
 *
 * @category conversions
 * @since 1.0.0
 */
export const toUnauthorized = (error: IntegrationError): Unauthorized => new Unauthorized({ message: error.summary })

/**
 * Maps a failure onto the control plane's `InvalidInput`.
 *
 * @category conversions
 * @since 1.0.0
 */
export const toInvalidInput = (error: IntegrationError): InvalidInput => new InvalidInput({ issue: error.summary })
