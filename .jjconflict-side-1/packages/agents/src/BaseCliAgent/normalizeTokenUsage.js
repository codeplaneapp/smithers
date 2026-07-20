/**
 * @typedef {import('./NormalizedTokenUsage.ts').NormalizedTokenUsage} NormalizedTokenUsage
 */

/** @type {Record<keyof NormalizedTokenUsage, ReadonlyArray<ReadonlyArray<string>>>} */
const usageFieldAliases = {
    inputTokens: [
        ["inputTokens"],
        ["promptTokens"],
        ["prompt_tokens"],
        ["input_tokens"],
        ["input"],
        ["models", "gemini", "tokens", "input"],
    ],
    outputTokens: [
        ["outputTokens"],
        ["completionTokens"],
        ["completion_tokens"],
        ["output_tokens"],
        ["output"],
        ["models", "gemini", "tokens", "output"],
    ],
    cacheReadTokens: [
        ["cacheReadTokens"],
        ["cache_read_input_tokens"],
        ["cached_input_tokens"],
        ["cache_read_tokens"],
        ["inputTokenDetails", "cacheReadTokens"],
    ],
    cacheWriteTokens: [
        ["cacheWriteTokens"],
        ["cache_write_input_tokens"],
        ["cache_creation_input_tokens"],
        ["cache_write_tokens"],
        ["inputTokenDetails", "cacheWriteTokens"],
    ],
    reasoningTokens: [
        ["reasoningTokens"],
        ["reasoning_tokens"],
        ["outputTokenDetails", "reasoningTokens"],
    ],
    totalTokens: [
        ["totalTokens"],
        ["total_tokens"],
    ],
};

/**
 * @param {unknown} value
 * @param {ReadonlyArray<string>} path
 * @returns {unknown}
 */
function readUsagePath(value, path) {
    let current = value;
    for (const segment of path) {
        if (!current || typeof current !== "object")
            return undefined;
        current = /** @type {Record<string, unknown>} */ (current)[segment];
    }
    return current;
}

/**
 * @param {NormalizedTokenUsage} usage
 * @returns {boolean}
 */
function hasMeaningfulTokenUsage(usage) {
    return Object.values(usage).some((value) => typeof value === "number" && Number.isFinite(value) && value > 0);
}

/**
 * @param {unknown} usage
 * @returns {NormalizedTokenUsage | null}
 */
export function normalizeTokenUsage(usage) {
    if (!usage || typeof usage !== "object")
        return null;
    /** @type {NormalizedTokenUsage} */
    const normalized = {};
    for (const [field, aliases] of /** @type {Array<[keyof NormalizedTokenUsage, ReadonlyArray<ReadonlyArray<string>>]>} */ (Object.entries(usageFieldAliases))) {
        for (const path of aliases) {
            const value = readUsagePath(usage, path);
            if (typeof value === "number") {
                normalized[field] = value;
                break;
            }
        }
    }
    return hasMeaningfulTokenUsage(normalized) ? normalized : null;
}
