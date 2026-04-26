import { z } from "zod/v4";

/**
 * Output schema for an extracted prompt using the R-C-T-F backbone:
 * Role, Context, Task, Format. The agent self-rates completeness via
 * `score` and explains via `scoreReason` — this is the gating signal
 * read by `<LoopUntilScored>`.
 */
export const rctfPromptSchema = z.looseObject({
  /** Rendered prompt body, suitable for paste into an LLM. */
  prompt: z.string(),
  /** Structured slots. */
  structured: z.object({
    role: z.string().default(""),
    context: z.string().default(""),
    task: z.string().default(""),
    format: z.string().default(""),
    constraints: z.array(z.string()).default([]),
    successCriteria: z.array(z.string()).default([]),
    outOfScope: z.array(z.string()).default([]),
  }),
  /** Self-score for R-C-T-F slot completeness (0..1). */
  score: z.number().min(0).max(1),
  /** Why the agent gave this score. */
  scoreReason: z.string(),
  /** A single Socratic follow-up question, if not yet complete. Empty when ready. */
  nextQuestion: z.string().default(""),
  /** Which Socratic principle the next question applies. */
  nextPrinciple: z
    .enum([
      "definition",
      "elenchus",
      "hypothesis-elimination",
      "generalization",
      "induction",
      "dialectic",
      "maieutic",
      "analogy",
      "irony",
      "recollection",
      "none",
    ])
    .default("none"),
  /** True if the agent thinks extraction is complete. */
  resolved: z.boolean().default(false),
  /** True if the user told the agent to ship despite score < threshold. */
  overridden: z.boolean().default(false),
  /** If overridden, why (verbatim from the user). */
  overrideReason: z.string().nullable().default(null),
});

export type RctfPromptOutput = z.infer<typeof rctfPromptSchema>;
