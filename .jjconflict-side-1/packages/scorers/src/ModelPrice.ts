/**
 * USD price for one model, per MILLION tokens. The invoice of record is the
 * provider's; this table drives spend estimates, dashboards, and the
 * per-session runaway brake.
 */
export type ModelPrice = {
  input: number;
  output: number;
  // Cache writes bill at 1.25x input, cache reads at 0.1x input, and neither is
  // included in input_tokens. Folding them in keeps cost estimates honest.
  cacheWrite: number;
  cacheRead: number;
};
