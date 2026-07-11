/**
 * Build the wire forms a provider might reflect. OAuth-style values may be
 * configured with their scheme already attached, while other clients add a
 * scheme at dispatch time.
 *
 * @param {...(string | undefined | null)} values
 * @returns {string[]}
 */
declare function credentialSecretValues(...values: (string | undefined | null)[]): string[];
/** @param {string} text @param {readonly string[]} secrets */
declare function redactSecretText(text: string, secrets: readonly string[]): string;
/**
 * Never attach the provider/library's original error object to a surfaced
 * IntegrationError: custom transports can include reflected request headers
 * in messages, enumerable details, or nested causes.
 *
 * @param {unknown} cause
 * @param {readonly string[]} secrets
 * @returns {Error}
 */
declare function sanitizeErrorCause(cause: unknown, secrets: readonly string[]): Error;

export { credentialSecretValues, redactSecretText, sanitizeErrorCause };
