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

const FREE: ModelPrice = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };

/**
 * Looks up the per-million-token price for a model id.
 *
 * Matches the base id plus any `-` or `_` date-stamp suffix and any bracketed
 * context-window alias such as `claude-opus-4-8[1m]`, so a real model is never
 * metered as free. An unknown id still records token counts and prices at zero
 * until its numbers are added above.
 *
 * @since 1.0.0
 * @category constructors
 */
export function modelPrices(model: string): ModelPrice {
  const normalized = String(model ?? "").toLowerCase();
  for (const [key, price] of Object.entries(PRICES)) {
    if (
      normalized === key ||
      normalized.startsWith(`${key}-`) ||
      normalized.startsWith(`${key}_`) ||
      normalized.startsWith(`${key}[`)
    ) {
      return price;
    }
  }
  return FREE;
}
