import type { EvalAssertion, EvalCaseInput } from "@smithers-orchestrator/scorers/evalCases";

export * from "@smithers-orchestrator/scorers/evalCases";

export type ReadEvalSuiteResult = {
  suiteId: string;
  name: string;
  workflowKey: string;
  workflowPath: string;
  workflowRoot: string;
  cases: EvalCaseInput[];
};

export declare function readEvalSuite(
  db: unknown,
  suiteId: string,
): Promise<ReadEvalSuiteResult | undefined>;

export type WriteEvalCaseRowInput = {
  id: string;
  evalRunId: string;
  suiteId: string;
  caseId: string;
  caseIndex: number;
  name?: string | null;
  status: "queued" | "running" | "ok" | "failed" | "cancelled";
  caseRunId?: string | null;
  input?: unknown;
  expected?: unknown;
  actual?: unknown;
  assertions?: EvalAssertion[];
  error?: string | null;
  startedAtMs?: number | null;
  finishedAtMs?: number | null;
  durationMs?: number | null;
};

export declare function writeEvalCaseRow(
  db: unknown,
  row: WriteEvalCaseRowInput,
): Promise<void>;
