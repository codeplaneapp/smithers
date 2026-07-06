import { modelTokenPrices } from "./modelTokenPrices.js";

/**
 * Price a token forecast into dollars. The `<Estimate>` component authors token
 * counts per task; this turns them into `costUsd` deterministically so the
 * model never has to reason about prices. Prices are per MILLION tokens.
 *
 * When only a single `tokens` total is known (no input/output split), it is
 * priced at the blended midpoint of input and output rates — a token forecast
 * this coarse cannot know its own read/write mix, and the midpoint keeps a
 * cheap model's estimate from swinging 5x on that unknown.
 *
 * @param {{ model: string, tokens?: number, inputTokens?: number, outputTokens?: number, cacheReadTokens?: number, cacheWriteTokens?: number }} usage
 * @returns {number} dollars
 */
export function estimateCostUsd(usage) {
  const price = modelTokenPrices(usage.model);
  const perMillion = (count, rate) =>
    (Math.max(0, Number(count) || 0) / 1_000_000) * rate;

  if (
    usage.inputTokens === undefined &&
    usage.outputTokens === undefined &&
    typeof usage.tokens === "number"
  ) {
    return perMillion(usage.tokens, (price.input + price.output) / 2);
  }

  return (
    perMillion(usage.inputTokens, price.input) +
    perMillion(usage.outputTokens, price.output) +
    perMillion(usage.cacheReadTokens, price.cacheRead) +
    perMillion(usage.cacheWriteTokens, price.cacheWrite)
  );
}
