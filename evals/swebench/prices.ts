/**
 * The committed price table the scorecard grades cost with.
 *
 * Prices are USD per million tokens, as published for the OpenAI API. They are
 * committed rather than fetched so that re-scoring an old run reproduces the
 * old number: a price change must be an edit here, with a date, not a silent
 * drift in someone's report.
 *
 * Verified 2026-08-19 against:
 *   - https://openai.com/index/advancing-the-price-performance-frontier-with-gpt-5-6/
 *     (the GPT-5.6 launch post: Sol at $5 / $30 per 1M input / output)
 *   - https://www.orcarouter.ai/blog/gpt-5-6-sol-pricing (verified 2026-08-18:
 *     $5.00 input on a cache miss, $0.50 cached input, $30.00 output)
 *   - https://openrouter.ai/openai/gpt-5.6-sol (quotes the same base rates
 *     under a promotional 50% discount, cache read at half of $0.50)
 *
 * A seat the table does not name is reported at zero cost with an explicit
 * `unpriced` note, never silently at another model's rate.
 *
 * @since 0.1.0
 */

/**
 * One model's USD price per million tokens.
 *
 * @category models
 * @since 0.1.0
 */
export interface Price {
  /** Uncached input tokens, USD per 1M. */
  readonly input: number
  /** Cache-read input tokens, USD per 1M. */
  readonly cachedInput: number
  /** Output tokens, including reasoning tokens, USD per 1M. */
  readonly output: number
  /** Where the numbers came from, and when they were checked. */
  readonly source: string
}

/**
 * The table, keyed by both the bare model id and the seat spelling the flows
 * CLI uses, because a run's journal records the seat and a codex run records
 * the model.
 *
 * @category constants
 * @since 0.1.0
 */
export const prices: Record<string, Price> = {
  "gpt-5.6-sol": {
    input: 5,
    cachedInput: 0.5,
    output: 30,
    source: "OpenAI API list price, verified 2026-08-19"
  },
  "openai:gpt-5.6-sol": {
    input: 5,
    cachedInput: 0.5,
    output: 30,
    source: "OpenAI API list price, verified 2026-08-19"
  }
}

/**
 * Computes USD for one run's token counts.
 *
 * `inputTokens` is the provider's total prompt count and already contains
 * `cachedInputTokens`, so the cached share is billed at the cache-read rate and
 * only the remainder at the input rate. Reasoning tokens are part of the output
 * count and are not billed twice.
 *
 * @category constructors
 * @since 0.1.0
 */
export const usd = (
  model: string | undefined,
  tokens: { readonly inputTokens: number; readonly cachedInputTokens: number; readonly outputTokens: number }
): { readonly usd: number | undefined; readonly source: string } => {
  const price = model === undefined ? undefined : prices[model]
  if (price === undefined) {
    return { usd: undefined, source: `unpriced: no committed price for ${model ?? "an unrecorded model"}` }
  }
  const uncached = Math.max(0, tokens.inputTokens - tokens.cachedInputTokens)
  const total = (uncached * price.input + tokens.cachedInputTokens * price.cachedInput
    + tokens.outputTokens * price.output) / 1_000_000
  return { usd: Math.round(total * 10_000) / 10_000, source: price.source }
}
