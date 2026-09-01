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
 * Whether `value` is a provider message id.
 *
 * The clients only ever record a positive safe integer, so anything else in a
 * `deliveredMessageIds` list came from a forged or foreign error. Exported
 * because the Telegram refinement has to agree with the conversion about what
 * a delivered id is: a list one accepts and the other rejects is how a throw
 * gets back into `Effect.mapError`.
 *
 * @category refinements
 * @since 1.0.0
 */
export const isMessageId = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0

/**
 * A provider message id, as a schema.
 *
 * The same rule {@link isMessageId} applies, at the journal boundary. A row is
 * data on disk that a later process decodes, so the field's documented type has
 * to be enforced on the way back in as well as on the way out: without this a
 * corrupt row hands a caller a "message id" of NaN, which is what
 * `Schema.Number` decodes the string "NaN" to.
 *
 * @category schemas
 * @since 1.0.0
 */
export const MessageId = Schema.Number.check(
  Schema.isInt(),
  Schema.isGreaterThan(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)
)

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
    retryable: Schema.Boolean,
    /**
     * The write may already have been applied.
     *
     * Set when a provider lost the answer to a POST, PATCH, PUT, DELETE, or
     * GraphQL mutation. It is the difference between "this did not happen" and
     * "nobody knows", and an operator deciding whether to run the step again
     * needs it, so it crosses the journal rather than living only on the
     * client error.
     */
    outcomeUnknown: Schema.optional(Schema.Boolean),
    /**
     * What a partially completed step already delivered.
     *
     * A Telegram send over the length limit is several messages inside one
     * step. When it fails partway through, these are the ids the chat already
     * shows, so a resend decision is made against what the reader has rather
     * than against a guess.
     */
    deliveredMessageIds: Schema.optional(Schema.Array(MessageId))
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
export const fromIntegrationError = (error: unknown): IntegrationFailure => {
  if (!isIntegrationError(error)) {
    return new IntegrationFailure({
      reason: "delivery-failed",
      message: capped(fallbackMessage(error)),
      retryable: false
    })
  }
  const details = error.details
  const delivered = details?.["deliveredMessageIds"]
  return new IntegrationFailure({
    reason: error.reason,
    message: capped(error.summary),
    retryable: isRetryable(error),
    ...(details?.["outcomeUnknown"] === true ? { outcomeUnknown: true } : {}),
    // Only when there is something to say, and only when every member really
    // is a message id. An empty list on every failure is noise in a row that
    // is written on every failed attempt, and `Schema.Number` encodes a
    // non-finite member as the string "NaN", so a row claiming a message id of
    // NaN is worse than one claiming none.
    ...(Array.isArray(delivered) && delivered.length > 0 && delivered.every(isMessageId)
      ? { deliveredMessageIds: delivered }
      : {})
  })
}

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
  new IntegrationError(failure.reason, failure.message, {
    retryable: failure.retryable,
    ...(failure.outcomeUnknown === undefined ? {} : { outcomeUnknown: failure.outcomeUnknown }),
    ...(failure.deliveredMessageIds === undefined ? {} : { deliveredMessageIds: failure.deliveredMessageIds })
  })
