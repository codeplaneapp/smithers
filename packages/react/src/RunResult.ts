export type RunResult = {
  runId: string;
  status:
    | "finished"
    | "failed"
    | "cancelled"
    | "continued"
    | "waiting-approval"
    | "waiting-event"
    | "waiting-timer";
  output?: unknown;
  error?: unknown;
  nextRunId?: string;
};
