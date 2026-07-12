import { modelTokenPrices } from "./modelTokenPrices.js";

const GPT_56_LONG_CONTEXT_THRESHOLD = 272_000;
const GPT_56_MODELS = ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"];

/** @param {string} model */
function isGpt56Model(model) {
  const normalized = String(model ?? "").toLowerCase();
  return GPT_56_MODELS.some(
    (base) =>
      normalized === base ||
      normalized.startsWith(`${base}-`) ||
      normalized.startsWith(`${base}_`) ||
      normalized.startsWith(`${base}[`),
  );
}

/** @param {unknown} value */
function tokenCount(value) {
  return Math.max(0, Number(value) || 0);
}

/**
 * GPT-5.6 requests above 272K input tokens price the entire request at 2x
 * input and 1.5x output. Cached reads and writes are input categories, so the
 * input multiplier applies to their published base rates too.
 *
 * @param {string} model
 * @param {number} inputTokens
 */
function requestMultipliers(model, inputTokens) {
  const longContext = isGpt56Model(model) && inputTokens > GPT_56_LONG_CONTEXT_THRESHOLD;
  return longContext ? { input: 2, output: 1.5 } : { input: 1, output: 1 };
}

/**
 * Price a token forecast into dollars. The `<Estimate>` component authors token
 * counts per task; this turns them into `costUsd` deterministically so the
 * model never has to reason about prices. Prices are per MILLION tokens.
 *
 * When only a single `tokens` total is known (no input/output split), it is
 * priced at the blended midpoint of input and output rates — a token forecast
 * this coarse cannot know its own read/write mix, and the midpoint keeps a
 * cheap model's estimate from swinging 5x on that unknown. The same 50/50
 * assumption determines whether a coarse GPT-5.6 forecast crosses the 272K
 * long-context input threshold.
 *
 * @param {{ model: string, tokens?: number, inputTokens?: number, outputTokens?: number, cacheReadTokens?: number, cacheWriteTokens?: number, pricingAtMs?: number }} usage
 * @returns {number} dollars
 */
export function estimateCostUsd(usage) {
  const price = modelTokenPrices(usage.model, usage.pricingAtMs);
  const perMillion = (count, rate) =>
    (tokenCount(count) / 1_000_000) * rate;

  if (
    usage.inputTokens === undefined &&
    usage.outputTokens === undefined &&
    typeof usage.tokens === "number"
  ) {
    const inputTokens = tokenCount(usage.tokens) / 2;
    const outputTokens = inputTokens;
    const multiplier = requestMultipliers(usage.model, inputTokens);
    return (
      perMillion(inputTokens, price.input * multiplier.input) +
      perMillion(outputTokens, price.output * multiplier.output)
    );
  }

  const inputTokens = tokenCount(usage.inputTokens);
  const cacheReadTokens = tokenCount(usage.cacheReadTokens);
  const cacheWriteTokens = tokenCount(usage.cacheWriteTokens);
  const multiplier = requestMultipliers(
    usage.model,
    inputTokens + cacheReadTokens + cacheWriteTokens,
  );

  return (
    perMillion(inputTokens, price.input * multiplier.input) +
    perMillion(usage.outputTokens, price.output * multiplier.output) +
    perMillion(cacheReadTokens, price.cacheRead * multiplier.input) +
    perMillion(cacheWriteTokens, price.cacheWrite * multiplier.input)
  );
}
