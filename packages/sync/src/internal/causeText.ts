/**
 * The bounded, transport-safe rendering of a host failure.
 *
 * `SyncError.cause` crosses the wire to a follower that may hold nothing but a
 * branch share link, so it carries a short string rather than the host object
 * that failed. An arbitrary `unknown` had three problems at once: it counted
 * against no ceiling, a class instance or a cyclic value has no defined wire
 * form, and whatever the host threw — a driver message with SQL text, a
 * rejected credential — went out verbatim.
 *
 * @since 1.0.0-rc.0
 */

/**
 * Longest cause rendering that crosses the wire. Long enough to name a failure
 * and short enough that an error can never be the largest thing a follower
 * receives.
 */
const maxCauseTextLength = 512

/**
 * Renders one host failure as a bounded string.
 *
 * An `Error` renders as `name: message`; anything else renders as its type
 * alone, because a non-`Error` value is arbitrary host data and its contents
 * are not this boundary's to publish. Nothing is retained beyond the returned
 * string, so an oversized input does not keep its subject alive.
 *
 * @category encoding
 * @since 1.0.0-rc.0
 */
export const causeText = (cause: unknown): string => {
  const text = cause instanceof Error
    ? `${cause.name}: ${cause.message}`
    : Object.prototype.toString.call(cause)
  return text.length <= maxCauseTextLength ? text : `${text.slice(0, maxCauseTextLength)} (truncated)`
}

/**
 * Renders one failure as its TYPE alone, with no message.
 *
 * The journal's message is the SQLite driver's, and it routinely carries SQL
 * text, table and column names, and constraint identifiers. A follower may
 * hold nothing but a branch share link, so what it learns about a storage
 * fault is the stable code the journal enumerates, never the sentence the
 * driver wrote. `decodeCapability` already refuses to be a parsing oracle;
 * this is the same rule for the read and write paths.
 *
 * @category encoding
 * @since 1.0.0-rc.0
 */
export const causeCode = (cause: unknown): string => {
  if (cause instanceof Error) {
    const code = (cause as { readonly code?: unknown }).code
    return typeof code === "string" ? `${cause.name}(${code})` : cause.name
  }
  return Object.prototype.toString.call(cause)
}
