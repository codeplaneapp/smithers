/** @typedef {import("./ModelPrice.js").ModelPrice} ModelPrice */

/**
 * Static USD price table, per MILLION tokens. Unknown ids still record token
 * counts but price at $0 until their numbers are added here. Keep this the ONE table:
 * `apps/review` re-exports it, and the `<Estimate>` component prices against it.
 *
 * @type {Record<string, ModelPrice>}
 */
const SONNET_5_STANDARD_START_MS = Date.UTC(2026, 8, 1);
const SONNET_5_INTRODUCTORY = { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 };
const SONNET_5_STANDARD = { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 };

const PRICES = {
  "gpt-5.6-sol": { input: 5, output: 30, cacheWrite: 6.25, cacheRead: 0.5 },
  "gpt-5.6-terra": { input: 2.5, output: 15, cacheWrite: 3.125, cacheRead: 0.25 },
  "gpt-5.6-luna": { input: 1, output: 6, cacheWrite: 1.25, cacheRead: 0.1 },
  "claude-fable-5": { input: 10, output: 50, cacheWrite: 12.5, cacheRead: 1 },
  "claude-opus-4-8": { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  "claude-opus-4-7": { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  "claude-sonnet-5": SONNET_5_INTRODUCTORY,
  "claude-sonnet-4-6": { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  "claude-haiku-4-5": { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 },
};

/** @type {ModelPrice} */
const FREE = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };

/**
 * Look up the per-million-token price for a model id. Matches the base id plus
 * any `-`/`_` date-stamp suffix or a bracketed context-window alias like
 * `claude-opus-4-8[1m]`, so a real model is never metered as free. Unknown ids
 * return the all-zero price.
 *
 * Sonnet 5's published introductory rate ends on September 1, 2026; encoding
 * the transition here prevents a deployment that survives that date from
 * silently under-metering new requests.
 *
 * @param {string} model
 * @param {number} [atMs]
 * @returns {ModelPrice}
 */
export function modelTokenPrices(model, atMs = Date.now()) {
  const normalized = String(model ?? "").toLowerCase();
  for (const [key, price] of Object.entries(PRICES)) {
    if (
      normalized === key ||
      normalized.startsWith(`${key}-`) ||
      normalized.startsWith(`${key}_`) ||
      normalized.startsWith(`${key}[`)
    ) {
      if (key === "claude-sonnet-5" && (!Number.isFinite(atMs) || atMs >= SONNET_5_STANDARD_START_MS)) {
        return SONNET_5_STANDARD;
      }
      return price;
    }
  }
  return FREE;
}
