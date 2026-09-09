/** @since 1.0.0 */

/**
 * Replaces literal credentials and authorization values, longest match first.
 * @private
 * @since 1.0.0
 */
export const redact = (text: string, secrets: ReadonlyArray<string | undefined>): string => {
  const patterns = secrets.filter((secret): secret is string => secret !== undefined && secret.length > 0)
    .sort((a, b) => b.length - a.length)
    .map((secret) => secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  return patterns.length === 0 ? text : text.replace(new RegExp(patterns.join("|"), "g"), "[REDACTED]")
}
