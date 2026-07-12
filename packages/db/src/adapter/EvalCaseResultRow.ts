export type EvalCaseResultRow = {
  /** `${evalRunId}:${caseId}` */
  id: string;
  evalRunId: string;
  suiteId: string;
  caseId: string;
  caseIndex: number;
  name?: string | null;
  status: "queued" | "running" | "ok" | "failed" | "cancelled";
  caseRunId?: string | null;
  inputJson?: string | null;
  expectedJson?: string | null;
  actualJson?: string | null;
  assertionsJson?: string | null;
  error?: string | null;
  startedAtMs?: number | null;
  finishedAtMs?: number | null;
  durationMs?: number | null;
};
