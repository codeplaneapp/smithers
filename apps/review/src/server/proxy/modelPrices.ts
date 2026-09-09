/**
 * The metered proxy's price table.
 *
 * The numbers are inlined here rather than imported. In 0.x this module
 * re-exported `smthrs/scorers`, which put a Cloudflare Worker's runaway brake
 * behind the whole workflow runtime; the rc.0 `@smthrs/scorers` is a score
 * store and carries no price table at all. A price table is a handful of
 * literals that change when a provider changes its rate card, so this app owns
 * its own copy and `tests/server/modelPrices.test.ts` pins it.
 *
 * @since 1.0.0
 */

/**
 * USD price for one model, per MILLION tokens.
 *
 * The invoice of record is the provider's; this table drives the proxy's spend
 * estimate and its per-repository monthly cap. Cache writes bill at 1.25x
 * input and cache reads at 0.1x input, and neither is included in
 * `input_tokens`, so folding them in is what keeps an estimate honest.
 *
 * @since 1.0.0
 * @category models
 */
export type ModelPrice = {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
};

const PRICES: Record<string, ModelPrice> = {
  "gpt-5.6-sol": { input: 5, output: 30, cacheWrite: 6.25, cacheRead: 0.5 },
  "gpt-5.6-terra": { input: 2.5, output: 15, cacheWrite: 3.125, cacheRead: 0.25 },
  "gpt-5.6-luna": { input: 1, output: 6, cacheWrite: 1.25, cacheRead: 0.1 },
  "claude-fable-5": { input: 10, output: 50, cacheWrite: 12.5, cacheRead: 1 },
  "claude-opus-5": { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  "claude-opus-4-8": { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  "claude-opus-4-7": { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  "claude-sonnet-5": { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  "claude-sonnet-4-6": { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  "claude-sonnet-4-5": { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  "claude-haiku-4-5": { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 },
};

/**
 * Looks up the per-million-token price for a model id.
 *
 * Matches only a priced base id or an eight-digit snapshot suffix. Unknown
 * ids throw so admission and settlement both fail closed. Context-window
 * aliases and arbitrary suffixes require explicit pricing before admission.
 *
 * @since 1.0.0
 * @category constructors
 */
export function modelPrices(model: string): ModelPrice {
  for (const [key, price] of Object.entries(PRICES)) {
    if (model === key || (model.startsWith(`${key}-`) && /^\d{8}$/.test(model.slice(key.length + 1)))) {
      return price;
    }
  }
  throw new Error(`unpriced model: ${model}`);
}
