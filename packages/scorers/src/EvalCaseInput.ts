import type { EvalJudge } from "./EvalJudge.ts";

/** One row of an authored eval dataset: the input and optional deterministic
 *  or LLM-judge assertions a case run is invoked with. */
export type EvalCaseInput = {
  id: string;
  name?: string;
  input: unknown;
  expected?: unknown;
  judge?: EvalJudge;
};
