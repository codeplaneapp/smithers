import type { WhyBlocker } from "./WhyBlocker.ts";

export type WhyDiagnosis = {
  runId: string;
  status: string;
  summary: string;
  generatedAtMs: number;
  blockers: WhyBlocker[];
  warnings?: string[];
  information: string[];
  currentNodeId: string | null;
};
