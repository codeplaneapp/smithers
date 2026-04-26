import type { Stakes } from "./PromptCache";

/**
 * Maps a stakes label to the score threshold required to consider an
 * extracted prompt "good enough":
 *
 *   - high → 1.0  (every R-C-T-F slot must be strongly filled)
 *   - low  → 0.7  (good enough for exploratory work)
 *
 * Callers can pass an explicit `threshold` to override this. Stakes is the
 * default for callers who don't want to think about exact numbers.
 */
export function stakesToThreshold(stakes: Stakes): number {
  return stakes === "high" ? 1.0 : 0.7;
}
