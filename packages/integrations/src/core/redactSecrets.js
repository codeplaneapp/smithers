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
        const credential = value.match(/^\S+\s+(.+)$/)?.[1];
        if (credential) secrets.add(credential);
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
