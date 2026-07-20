import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { decodeJwtClaims } from "./decodeJwtClaims.js";

/**
 * Reads the Codex ChatGPT-subscription OAuth token for an account from
 * `configDir/auth.json` (the per-account `CODEX_HOME`). The ChatGPT account id
 * comes from `tokens.account_id`, or failing that the `chatgpt_account_id`
 * claim inside the `id_token` JWT.
 *
 * Returns `null` when no credential can be read or the account uses an API key
 * instead of ChatGPT auth. The token is returned only to mint an outbound
 * Authorization header.
 *
 * @param {{ configDir?: string }} account
 * @returns {{ accessToken: string; accountId?: string } | null}
 */
export function readCodexCredentials(account) {
    if (!account.configDir) return null;
    const path = join(account.configDir, "auth.json");
    if (!existsSync(path)) return null;
    let json;
    try {
        json = JSON.parse(readFileSync(path, "utf8"));
    } catch {
        return null;
    }
    const tokens = json?.tokens;
    const accessToken = tokens?.access_token;
    if (typeof accessToken !== "string" || accessToken === "") return null;
    let accountId = typeof tokens?.account_id === "string" ? tokens.account_id : undefined;
    if (!accountId) {
        const claims = decodeJwtClaims(tokens?.id_token);
        const authClaim = /** @type {Record<string, unknown> | undefined} */ (
            claims["https://api.openai.com/auth"]
        );
        const fromClaim = authClaim?.chatgpt_account_id;
        if (typeof fromClaim === "string") accountId = fromClaim;
    }
    return { accessToken, accountId };
}
