export type SteerRow = {
  steerId: string;
  runId: string;
  nodeId: string;
  message: string;
  status: string;
  author: string | null;
  createdAtMs: number;
  consumedAtMs: number | null;
  consumedByAttempt: number | null;
  consumedByIteration: number | null;
  expiredAtMs: number | null;
};
