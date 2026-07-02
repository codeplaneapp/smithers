/**
 * Static USD price table per million tokens. The invoice of record is
 * Anthropic's; this table is for spend dashboards and the per-session runaway
 * brake. Unknown models still record token counts but cost $0.
 */
export interface ModelPrice {
  input: number;
  output: number;
  // Cache writes bill at 1.25x input, cache reads at 0.1x input, and neither is
  // included in input_tokens. Folding them in keeps the runaway brake honest.
  cacheWrite: number;
  cacheRead: number;
}

const PRICES: Record<string, ModelPrice> = {
  "claude-fable-5": { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 },
  "claude-opus-4-8": { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 },
  "claude-opus-4-7": { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 },
  "claude-sonnet-4-6": { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  "claude-haiku-4-5": { input: 0.8, output: 4, cacheWrite: 1, cacheRead: 0.08 },
};

export function modelPrices(model: string): ModelPrice {
  const normalized = model.toLowerCase();
  for (const [key, price] of Object.entries(PRICES)) {
    if (normalized === key || normalized.startsWith(`${key}-`) || normalized.startsWith(`${key}_`)) {
      return price;
    }
  }
  return { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
}
