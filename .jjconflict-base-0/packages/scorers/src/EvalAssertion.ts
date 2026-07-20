/** One assertion result within a graded eval case. Judge assertions add their
 *  normalized score and explanation without changing deterministic rows. */
export type EvalAssertion = {
  description: string;
  passed: boolean;
  score?: number;
  reason?: string;
};
