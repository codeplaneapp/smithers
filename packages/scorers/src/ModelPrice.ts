/**
 * USD price for one model, per MILLION tokens. The invoice of record is the
 * provider's; this table drives spend estimates, dashboards, and the
 * per-session runaway brake.
 */
export type ModelPrice = {
  input: number;
  output: number;
  // Five-minute cache writes bill at 1.25x input, cache reads at 0.1x input,
  // and neither is included in input_tokens. One-hour cache writes are a
  // separate 2x category and must not be folded into this rate.
  cacheWrite: number;
  cacheRead: number;
};
