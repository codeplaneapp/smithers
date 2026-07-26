import type { EvalCaseInput } from "./EvalCaseInput.ts";

export type EvalDatasetParseResult = { ok: true; cases: EvalCaseInput[] } | { ok: false; error: string };
