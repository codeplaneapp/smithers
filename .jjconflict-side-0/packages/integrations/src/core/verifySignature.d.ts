/**
 * Compute the lowercase hex HMAC-SHA256 of `payload` with `secret`.
 * @param {string | Uint8Array} payload
 * @param {string} secret
 * @returns {string}
 */
declare function computeHmacSha256Hex(payload: string | Uint8Array, secret: string): string;
/**
 * Verify an HMAC-SHA256 webhook signature in constant time.
 *
 * Accepts the GitHub style (`sha256=<hex>` in `X-Hub-Signature-256`; pass
 * `prefix: "sha256="` or rely on the default prefix stripping) as well as
 * plain hex or base64 digests (Linear's `Linear-Signature` is plain hex).
 *
 * @param {{
 *   payload: string | Uint8Array;
 *   secret: string;
 *   signature: string | null | undefined;
 *   prefix?: string;
 * }} options
 * @returns {boolean} true only when the signature matches.
 */
declare function verifySignature(options: {
    payload: string | Uint8Array;
    secret: string;
    signature: string | null | undefined;
    prefix?: string;
}): boolean;

export { computeHmacSha256Hex, verifySignature };
