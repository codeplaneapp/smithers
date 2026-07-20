import { createHmac, timingSafeEqual } from "node:crypto";

const HEX_RE = /^[0-9a-f]+$/i;
// Standard base64 (Linear sends hex, but some providers sign with base64).
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * Compute the lowercase hex HMAC-SHA256 of `payload` with `secret`.
 * @param {string | Uint8Array} payload
 * @param {string} secret
 * @returns {string}
 */
export function computeHmacSha256Hex(payload, secret) {
    return createHmac("sha256", secret).update(payload).digest("hex");
}

/**
 * @param {Buffer} expected
 * @param {Buffer | null} candidate
 * @returns {boolean}
 */
function safeEqual(expected, candidate) {
    if (!candidate || candidate.length !== expected.length) {
        return false;
    }
    return timingSafeEqual(expected, candidate);
}

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
export function verifySignature(options) {
    const { payload, secret, signature, prefix } = options;
    if (typeof signature !== "string" || signature.length === 0 || !secret) {
        return false;
    }
    let provided = signature.trim();
    if (prefix !== undefined) {
        if (!provided.toLowerCase().startsWith(prefix.toLowerCase())) {
            return false;
        }
        provided = provided.slice(prefix.length);
    }
    else if (provided.toLowerCase().startsWith("sha256=")) {
        provided = provided.slice("sha256=".length);
    }
    if (!provided) {
        return false;
    }
    const expected = createHmac("sha256", secret).update(payload).digest();
    // Hex digest (the common case for GitHub/Linear).
    if (provided.length === expected.length * 2 && HEX_RE.test(provided)) {
        if (safeEqual(expected, Buffer.from(provided, "hex"))) {
            return true;
        }
    }
    // Base64 digest fallback.
    if (BASE64_RE.test(provided)) {
        try {
            if (safeEqual(expected, Buffer.from(provided, "base64"))) {
                return true;
            }
        }
        catch {
            // fallthrough — not valid base64
        }
    }
    return false;
}
