/**
 * Replace any known secret substring inside a message with `[redacted]`. Used
 * as defense-in-depth on error messages the transport and runners surface,
 * since those paths bypass the provider-kit's own exec scrubbing.
 *
 * @param {string} text
 * @param {string[]} secrets
 * @returns {string}
 */
export function scrubAwsSandboxSecrets(text, secrets) {
	let out = String(text ?? "");
	for (const secret of secrets) {
		if (secret) {
			out = out.split(secret).join("[redacted]");
		}
	}
	return out;
}
