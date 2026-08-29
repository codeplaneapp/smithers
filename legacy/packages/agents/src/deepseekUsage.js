import { isRecord, asNumber } from "./BaseCliAgent/index.js";

/** @typedef {import("./BaseCliAgent/NormalizedTokenUsage.ts").NormalizedTokenUsage} NormalizedTokenUsage */

/**
 * Anthropic-style usage aliases that are ambiguous when Claude Code is
 * routed to a custom Anthropic-compatible provider. Under DeepSeek's
 * supported integration, cache accounting is reported with provider-specific
 * fields; a legacy alias could be a cache hit, a cache miss, or total input,
 * so reading it silently would mis-bill the invocation.
 */
const DEEPSEEK_LEGACY_USAGE_ALIASES = ["cache_read_input_tokens", "cache_creation_input_tokens", "input_tokens"];

/**
 * @param {unknown} value
 * @returns {number | undefined}
 */
function counter(value) {
  const n = asNumber(value);
  return typeof n === "number" && n >= 0 ? n : undefined;
}

/**
 * Build a usage normalizer for DeepSeek's supported Claude Code integration.
 * The returned function receives the raw result payload and returns
 * Smithers' normalized usage shape:
 *
 * - `prompt_cache_miss_tokens` -> `inputTokens` (uncached input)
 * - `prompt_cache_hit_tokens` -> `cacheReadTokens`
 * - `output_tokens` -> `outputTokens`
 * - `totalTokens` is the sum of the three.
 *
 * Ambiguous legacy Anthropic aliases (`input_tokens`,
 * `cache_read_input_tokens`, `cache_creation_input_tokens`) are rejected
 * with a descriptive error rather than silently misread. Payloads without
 * any provider counters return undefined so the caller can fall back to its
 * default handling.
 *
 * @returns {(rawResult: unknown) => NormalizedTokenUsage | undefined}
 */
export function createDeepSeekUsageNormalizer() {
  return (rawResult) => {
    if (!isRecord(rawResult)) return undefined;
    const usage = isRecord(rawResult.usage) ? rawResult.usage : rawResult;
    for (const alias of DEEPSEEK_LEGACY_USAGE_ALIASES) {
      if (usage[alias] !== undefined) {
        throw new Error(
          `ambiguous legacy usage alias "${alias}" in custom-provider result payload; ` +
            "expected DeepSeek fields prompt_cache_miss_tokens, prompt_cache_hit_tokens, output_tokens",
        );
      }
    }
    const inputTokens = counter(usage.prompt_cache_miss_tokens);
    const cacheReadTokens = counter(usage.prompt_cache_hit_tokens);
    const outputTokens = counter(usage.output_tokens);
    if (inputTokens === undefined && cacheReadTokens === undefined && outputTokens === undefined) {
      return undefined;
    }
    /** @type {NormalizedTokenUsage} */
    const normalized = {};
    if (inputTokens !== undefined) normalized.inputTokens = inputTokens;
    if (cacheReadTokens !== undefined) normalized.cacheReadTokens = cacheReadTokens;
    if (outputTokens !== undefined) normalized.outputTokens = outputTokens;
    normalized.totalTokens = (inputTokens ?? 0) + (cacheReadTokens ?? 0) + (outputTokens ?? 0);
    return normalized;
  };
}
