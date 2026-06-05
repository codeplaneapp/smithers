import { clampSplitFraction } from "./clampSplitFraction";

/**
 * Convert a horizontal pointer position into the clamped chat-column fraction
 * for the split divider. `pointerX` and `left`/`width` are container-relative
 * pixels (from `getBoundingClientRect`). Pure + unit-tested without a DOM.
 */
export function splitFractionFromPointer(pointerX: number, left: number, width: number): number {
  if (width <= 0) return clampSplitFraction(NaN);
  return clampSplitFraction((pointerX - left) / width);
}
