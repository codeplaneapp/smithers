/** One row of an authored eval dataset — the input (and optional expected
 *  output) a case run is invoked with. Mirrors multi's `EvalCaseInput`
 *  (`src/evals/evalReport.ts`) byte-for-byte. */
export type EvalCaseInput = {
  id: string;
  name?: string;
  input: unknown;
  expected?: unknown;
};
