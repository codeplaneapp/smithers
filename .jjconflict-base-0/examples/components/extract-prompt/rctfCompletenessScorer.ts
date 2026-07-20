import { llmJudge } from "@smithers-orchestrator/scorers";
import type { Scorer } from "@smithers-orchestrator/scorers";

export type RctfCompletenessScorerOptions = {
  /** The judge agent. Must implement `generate({ prompt }) → string | { text }`. */
  judge: { generate: (args: { prompt: string }) => Promise<unknown> };
  id?: string;
  name?: string;
  description?: string;
};

/**
 * LLM-as-judge scorer that grades how completely an output fills the
 * R-C-T-F slots (Role, Context, Task, Format). Used as the *async*
 * observability scorer on `<Task>` — independent verification of the
 * agent's self-score, not the gating signal.
 *
 * Score is an average over the four slots; `score === 1.0` means every
 * slot is strongly and unambiguously filled.
 */
export function rctfCompletenessScorer(opts: RctfCompletenessScorerOptions): Scorer {
  return llmJudge({
    id: opts.id ?? "rctf-completeness",
    name: opts.name ?? "R-C-T-F Completeness",
    description:
      opts.description ??
      "Rates an extracted prompt by how completely it fills Role, Context, Task, Format.",
    judge: opts.judge as never,
    instructions:
      "You are a strict evaluator of extracted LLM prompts. " +
      "Rate the prompt's completeness across four slots: Role, Context, Task, Format. " +
      "Return a JSON object with `score` (a number in [0,1]) and `reason` (string). " +
      "score = 1.0 means every slot is strongly and unambiguously filled. " +
      "score = 0.0 means no slots are filled. " +
      "Average across the four slots; ignore other fields.",
    promptTemplate: ({ output }) => {
      const text =
        typeof output === "string" ? output : JSON.stringify(output, null, 2);
      return [
        "Evaluate this extracted prompt against the R-C-T-F backbone.",
        "",
        "Extracted prompt (JSON):",
        "```json",
        text,
        "```",
        "",
        'Return ONLY a JSON object: {"score": <0..1>, "reason": "<short>"}',
      ].join("\n");
    },
  });
}
