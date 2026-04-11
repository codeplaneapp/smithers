import type { Scorer } from "./types";
import type { CreateScorerConfig } from "./CreateScorerConfig";

/**
 * Creates a scorer from a plain configuration object.
 *
 * ```ts
 * const myScorer = createScorer({
 *   id: "word-count",
 *   name: "Word Count",
 *   description: "Scores based on word count",
 *   score: async ({ output }) => ({
 *     score: Math.min(String(output).split(/\s+/).length / 200, 1),
 *   }),
 * });
 * ```
 */
export function createScorer(config: CreateScorerConfig): Scorer {
  return {
    id: config.id,
    name: config.name,
    description: config.description,
    score: config.score,
  };
}
