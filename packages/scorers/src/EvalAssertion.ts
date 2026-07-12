/** One assertion result within a graded eval case (a scripted expect(), not
 *  an LLM scorer). Mirrors multi's `EvalAssertion` (`src/evals/evalReport.ts`). */
export type EvalAssertion = {
  description: string;
  passed: boolean;
};
