/**
 * The failure a durable action reports.
 *
 * {@link IntegrationError} is a class. A durable action has to write its
 * failure to the journal and read it back after a restart, so the action
 * boundary needs a schema instead. {@link IntegrationFailure} is that schema:
 * the reason, a message already safe to persist, and whether another attempt
 * could clear it. Nothing else crosses, because nothing else in an
 * `IntegrationError` survives encoding.
 *
 * @since 1.0.0
 */
import { Schema } from "effect"
import { IntegrationError, isIntegrationError, isRetryable, reasons } from "./IntegrationError.ts"

/**
 * The classification, as a schema.
 *
 * Built from `IntegrationError`'s own reason list, so a reason added there is
 * decodable here without a second edit.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Reason = Schema.Literals(reasons)

/**
 * A provider failure in the form a durable action encodes.
 *
 * @category errors
 * @since 1.0.0
 */
export class IntegrationFailure extends Schema.TaggedError<IntegrationFailure>()(
  "/integrations/IntegrationFailure",
  {
    reason: Reason,
    message: Schema.String,
    retryable: Schema.Boolean
  }
) {}

/**
 * Converts a client failure into the schema-backed form.
 *
 * A failure that is not an {@link IntegrationError} came from outside the
 * clients, so it is reported as a non-retryable `delivery-failed` rather than
 * guessed at.
 *
 * @category conversions
 * @since 1.0.0
 */
export const fromIntegrationError = (error: unknown): IntegrationFailure =>
  isIntegrationError(error)
    ? new IntegrationFailure({
      reason: error.reason,
      message: error.summary,
      retryable: isRetryable(error)
    })
    : new IntegrationFailure({
      reason: "delivery-failed",
      message: error instanceof Error ? error.message : String(error),
      retryable: false
    })

/**
 * Converts the schema-backed form back into a client failure.
 *
 * A caller that catches an action failure and wants the class back, to reuse
 * {@link isRetryable} or the control-plane mappings, gets it here.
 *
 * @category conversions
 * @since 1.0.0
 */
export const toIntegrationError = (failure: IntegrationFailure): IntegrationError =>
  new IntegrationError(failure.reason, failure.message, { retryable: failure.retryable })
