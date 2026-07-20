import type { Approval, RunState } from "./runsStore";

/**
 * Derive the pending/approved/denied `Approval` for a run, or undefined when the
 * run has no gate. Pure, for the same reason as `selectRun`.
 */
export function selectApproval(
  runs: RunState[],
  runId: string,
): Approval | undefined {
  const run = runs.find((entry) => entry.id === runId);
  if (!run || run.gate === "none") {
    return undefined;
  }
  const status = run.gate === "pending" ? "pending" : run.gate;
  return {
    runId,
    title: run.title,
    gate: "deploy-to-prod",
    status,
    note: run.note,
  };
}
