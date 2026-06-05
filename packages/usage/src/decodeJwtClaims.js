/**
 * Decodes the claims (the middle segment) of a JWT without verifying its
 * signature. Used to read the `chatgpt_account_id` claim out of the Codex
 * `id_token` when `auth.json` does not carry `tokens.account_id` directly.
 *
 * Verification is intentionally skipped: the token already authenticated the
 * user with the provider, and we only read a non-secret routing claim from it.
 *
 * Returns an empty object for anything that is not a decodable JWT.
 *
 * @param {string | null | undefined} token
 * @returns {Record<string, unknown>}
 */
export function decodeJwtClaims(token) {
    if (typeof token !== "string") return {};
    const parts = token.split(".");
    if (parts.length < 2) return {};
    try {
        const payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
        const json = Buffer.from(payload, "base64").toString("utf8");
        const claims = JSON.parse(json);
        return claims && typeof claims === "object" ? claims : {};
    } catch {
        return {};
    }
}
