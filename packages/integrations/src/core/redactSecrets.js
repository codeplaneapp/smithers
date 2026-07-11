/**
 * Build the wire forms a provider might reflect. OAuth-style values may be
 * configured with their scheme already attached, while other clients add a
 * scheme at dispatch time.
 *
 * @param {...(string | undefined | null)} values
 * @returns {string[]}
 */
export function credentialSecretValues(...values) {
    const secrets = new Set();
    for (const value of values) {
        if (!value) continue;
        secrets.add(value);

        // Keep this parser linear: a repeated whitespace matcher followed by a
        // repeated wildcard can backtrack quadratically on a long, malformed
        // credential. `trimStart` uses the same ECMAScript whitespace set as
        // `\s`, and credentials containing later line breaks were never valid
        // wire forms here.
        const separatorStart = value.search(/\s/u);
        if (separatorStart <= 0) continue;
        const separatorTail = value.slice(separatorStart);
        const credential = separatorTail.trimStart();
        if (credential && !/[\n\r\u2028\u2029]/u.test(credential)) {
            secrets.add(credential);
        } else if (!credential && separatorTail.length > 1) {
            // Preserve the previous matcher's edge case for an all-whitespace
            // tail: it retained one final non-line-break separator.
            const finalSeparator = separatorTail[separatorTail.length - 1];
            if (!/[\n\r\u2028\u2029]/u.test(finalSeparator)) {
                secrets.add(finalSeparator);
            }
        }
    }
    return [...secrets].sort((left, right) => right.length - left.length);
}

/** @param {string} text @param {readonly string[]} secrets */
export function redactSecretText(text, secrets) {
    let safe = text;
    for (const secret of secrets) {
        safe = safe.split(secret).join("[REDACTED]");
    }
    return safe;
}

/**
 * Never attach the provider/library's original error object to a surfaced
 * IntegrationError: custom transports can include reflected request headers
 * in messages, enumerable details, or nested causes.
 *
 * @param {unknown} cause
 * @param {readonly string[]} secrets
 * @returns {Error}
 */
export function sanitizeErrorCause(cause, secrets) {
    const message = cause instanceof Error ? cause.message : String(cause);
    const safe = new Error(redactSecretText(message, secrets));
    safe.name = cause instanceof Error ? cause.name : "Error";
    return safe;
}
