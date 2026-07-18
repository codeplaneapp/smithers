import type { EvalJudge } from "./EvalJudge.ts";

/** Async adapter used to grade one normalized eval judge assertion. */
export type EvalJudgeRunner = (input: {
  judge: EvalJudge & { threshold: number };
  input?: unknown;
  expected?: unknown;
  status?: string;
  output?: unknown;
  error?: unknown;
}) => Promise<{ score: number; reason?: string }>;
