/**
 * The split divider's chat-column fraction, clamped to a sane range so neither
 * the chat nor the overlay can be dragged shut. Pure so it is unit-tested without
 * a DOM. `0.5` means an even split; `MIN_SPLIT_FRACTION`/`MAX_SPLIT_FRACTION`
 * keep both panes usable.
 */
export const MIN_SPLIT_FRACTION = 0.25;
export const MAX_SPLIT_FRACTION = 0.75;
export const DEFAULT_SPLIT_FRACTION = 0.55;

export function clampSplitFraction(fraction: number): number {
  if (!Number.isFinite(fraction)) return DEFAULT_SPLIT_FRACTION;
  if (fraction < MIN_SPLIT_FRACTION) return MIN_SPLIT_FRACTION;
  if (fraction > MAX_SPLIT_FRACTION) return MAX_SPLIT_FRACTION;
  return fraction;
}
