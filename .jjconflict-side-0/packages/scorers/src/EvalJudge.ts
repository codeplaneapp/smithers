/** An LLM-judge assertion authored on an eval dataset case. */
export type EvalJudge = {
  /** The natural-language requirement the case output must satisfy. */
  instructions: string;
  /** Minimum passing score from 0 to 1. Defaults to EVAL_PASS_THRESHOLD. */
  threshold?: number;
};
