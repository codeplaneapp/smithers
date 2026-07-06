/** @typedef {import("./ModelPrice.js").ModelPrice} ModelPrice */

/**
 * Static USD price table, per MILLION tokens. Anthropic ids are priced today;
 * non-Anthropic ids (gpt-*, gemini-*, kimi-*) still record token counts but
 * price at $0 until their numbers are added here. Keep this the ONE table:
 * `apps/review` re-exports it, and the `<Estimate>` component prices against it.
 *
 * @type {Record<string, ModelPrice>}
 */
const PRICES = {
  "claude-fable-5": { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 },
  "claude-opus-4-8": { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 },
  "claude-opus-4-7": { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 },
  "claude-sonnet-5": { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  "claude-sonnet-4-6": { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  "claude-haiku-4-5": { input: 0.8, output: 4, cacheWrite: 1, cacheRead: 0.08 },
};

/** @type {ModelPrice} */
const FREE = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };

/**
 * Look up the per-million-token price for a model id. Matches the base id plus
 * any `-`/`_` date-stamp suffix or a bracketed context-window alias like
 * `claude-opus-4-8[1m]`, so a real model is never metered as free. Unknown ids
 * return the all-zero price.
 *
 * @param {string} model
 * @returns {ModelPrice}
 */
export function modelTokenPrices(model) {
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
