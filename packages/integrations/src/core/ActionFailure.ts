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
 * The longest provider text a failure persists.
 *
 * The message is journaled, so an unbounded provider description would be
 * written to the run database on every failed attempt. The cap is generous
 * enough for any classification a caller reads and short enough that the
 * journal row stays a row.
 *
 * @category constants
 * @since 1.0.0
 */
export const MAX_MESSAGE_LENGTH = 512

const capped = (message: string): string =>
  message.length <= MAX_MESSAGE_LENGTH ? message : `${message.slice(0, MAX_MESSAGE_LENGTH - 1)}…`

/**
 * The persisted text for a failure that is not an {@link IntegrationError}.
 *
 * `summary` rather than `message`, because `SmithersError` appends its
 * documentation URL to `message` and the other providers journal the summary.
 * Reading the same field everywhere keeps one failed send from looking
 * different depending on which client raised it.
 */
const fallbackMessage = (error: unknown): string => {
  if (typeof error === "object" && error !== null && "summary" in error) {
    const summary = (error as { readonly summary?: unknown }).summary
    if (typeof summary === "string") return summary
  }
  return error instanceof Error ? error.message : String(error)
}

/**
 * Converts a client failure into the schema-backed form.
 *
 * A failure that is not an {@link IntegrationError} came from outside the
 * clients, so it is reported as a non-retryable `delivery-failed` rather than
 * guessed at. The conversion is total: an error that only claims the
 * `IntegrationError` name, or carries a reason this build cannot encode, takes
 * the unclassified branch rather than failing schema validation inside
 * `Effect.mapError`, where the throw would become a defect.
 *
 * @category conversions
 * @since 1.0.0
 */
export const fromIntegrationError = (error: unknown): IntegrationFailure =>
  isIntegrationError(error)
    ? new IntegrationFailure({
      reason: error.reason,
      message: capped(error.summary),
      retryable: isRetryable(error)
    })
    : new IntegrationFailure({
      reason: "delivery-failed",
      message: capped(fallbackMessage(error)),
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
