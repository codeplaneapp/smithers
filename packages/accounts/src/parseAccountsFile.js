import { SmithersError } from "@smithers-orchestrator/errors/SmithersError";

const VALID_PROVIDERS = new Set([
    "claude-code",
    "antigravity",
    "codex",
    "gemini",
    "kimi",
    "anthropic-api",
    "openai-api",
    "gemini-api",
]);

const SUBSCRIPTION_PROVIDERS = new Set([
    "claude-code",
    "antigravity",
    "codex",
    "gemini",
    "kimi",
]);

const API_KEY_PROVIDERS = new Set([
    "anthropic-api",
    "openai-api",
    "gemini-api",
]);

/**
 * Parses a raw JSON string into a validated AccountsFile. Throws SmithersError
 * with code `ACCOUNTS_FILE_INVALID` if the shape is wrong. Tolerates missing
 * accounts.json (caller passes an empty string for that).
 *
 * @param {string} raw
 * @returns {import("./AccountsFile.ts").AccountsFile}
 */
export function parseAccountsFile(raw) {
    if (!raw.trim()) {
        return { version: 1, accounts: [] };
    }
    /** @type {unknown} */
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch (cause) {
        throw new SmithersError("ACCOUNTS_FILE_INVALID", `accounts.json is not valid JSON: ${cause?.message ?? String(cause)}`);
    }
    if (!parsed || typeof parsed !== "object") {
        throw new SmithersError("ACCOUNTS_FILE_INVALID", "accounts.json must be a JSON object");
    }
    const obj = /** @type {Record<string, unknown>} */ (parsed);
    if (obj.version !== 1) {
        throw new SmithersError("ACCOUNTS_FILE_INVALID", `accounts.json: unsupported version ${JSON.stringify(obj.version)} (expected 1)`);
    }
    if (!Array.isArray(obj.accounts)) {
        throw new SmithersError("ACCOUNTS_FILE_INVALID", "accounts.json: `accounts` must be an array");
    }
    const seenLabels = new Set();
    /** @type {import("./Account.ts").Account[]} */
    const accounts = [];
    for (let i = 0; i < obj.accounts.length; i++) {
        const entry = obj.accounts[i];
        if (!entry || typeof entry !== "object") {
            throw new SmithersError("ACCOUNTS_FILE_INVALID", `accounts.json: accounts[${i}] must be an object`);
        }
        const e = /** @type {Record<string, unknown>} */ (entry);
        if (typeof e.label !== "string" || !e.label.trim()) {
            throw new SmithersError("ACCOUNTS_FILE_INVALID", `accounts.json: accounts[${i}].label must be a non-empty string`);
        }
        if (typeof e.provider !== "string" || !VALID_PROVIDERS.has(e.provider)) {
            throw new SmithersError("ACCOUNTS_FILE_INVALID", `accounts.json: accounts[${i}].provider must be one of ${[...VALID_PROVIDERS].join(", ")}, got ${JSON.stringify(e.provider)}`);
        }
        if (seenLabels.has(e.label)) {
            throw new SmithersError("ACCOUNTS_FILE_INVALID", `accounts.json: duplicate label ${JSON.stringify(e.label)}`);
        }
        seenLabels.add(e.label);
        const isSubscription = SUBSCRIPTION_PROVIDERS.has(e.provider);
        const isApiKey = API_KEY_PROVIDERS.has(e.provider);
        if (typeof e.configDir === "string" && typeof e.apiKey === "string") {
            throw new SmithersError("ACCOUNTS_FILE_INVALID", `accounts.json: ${e.label} (${e.provider}) must set configDir or apiKey, never both`);
        }
        if (isSubscription && (typeof e.configDir !== "string" || !e.configDir.trim())) {
            throw new SmithersError("ACCOUNTS_FILE_INVALID", `accounts.json: ${e.label} (${e.provider}) requires a non-empty configDir`);
        }
        if (isApiKey && typeof e.apiKey !== "string") {
            throw new SmithersError("ACCOUNTS_FILE_INVALID", `accounts.json: ${e.label} (${e.provider}) requires apiKey (may be empty string for env-var-only)`);
        }
        accounts.push({
            label: e.label,
            provider: e.provider,
            configDir: typeof e.configDir === "string" ? e.configDir : undefined,
            apiKey: typeof e.apiKey === "string" ? e.apiKey : undefined,
            model: typeof e.model === "string" ? e.model : undefined,
            addedAt: typeof e.addedAt === "string" ? e.addedAt : undefined,
        });
    }
    return { version: 1, accounts };
}

export { SUBSCRIPTION_PROVIDERS, API_KEY_PROVIDERS, VALID_PROVIDERS };
