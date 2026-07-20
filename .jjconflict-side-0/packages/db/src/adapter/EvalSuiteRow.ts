export type EvalSuiteRow = {
  suiteId: string;
  name: string;
  workflowKey: string;
  workflowPath: string;
  workflowRoot: string;
  /** Canonical parsed dataset (`EvalCaseInput[]`), JSON-encoded. */
  datasetJson: string;
  caseCount: number;
  createdAtMs: number;
  updatedAtMs: number;
};
