/** @typedef {import("@smthrs/db/adapter").SmithersDb} SmithersDb */

/**
 * The engine records a cancellation by writing a *denial* approval whose author
 * is this sentinel (engine.js sets `decidedBy: "smithers:cancel"` with
 * `decisionJson: { cancelled: true }`). A genuine operator `smithers deny`
 * never uses it, so the sentinel is what tells a human-denied gate apart from a
 * cancel-driven one.
 */
export const CANCEL_APPROVAL_AUTHOR = "smithers:cancel";

/**
 * Run statuses that mean "parked, waiting for something outside the engine" —
 * not terminal, so never autopsy-worthy. `waiting-quota` is deliberately absent:
 * it has its own, more specific cause.
 */
export const PARKED_RUN_STATUSES = new Set(["waiting-approval", "waiting-event", "waiting-timer"]);

/**
 * @typedef {"human-denied" | "cancelled" | "quota-parked" | "not-terminal" | "task-error"} TerminalCause
 */

/**
 * Classify WHY a run reached its failed/terminal state, reading the ledger the
 * cause is already recorded in. Only a genuine, unexpected task error
 * (`"task-error"`) warrants a post-failure autopsy; a human-denied gate, an
 * operator cancel, a quota park, or a run that never actually terminated all
 * already have their cause recorded, so autopsying them just burns agent tokens
 * investigating a decision.
 *
 * Reads are defensive: any ledger lookup that throws degrades to the
 * autopsy-worthy `"task-error"` so a genuine failure is never silently
 * swallowed by a classification error.
 *
 * @param {SmithersDb} adapter
 * @param {string} runId
 * @param {{ status?: string | null }} [result]
 * @returns {Promise<TerminalCause>}
 */
export async function classifyTerminalCause(adapter, runId, result) {
  const run = await Promise.resolve(adapter.getRun(runId)).catch(() => undefined);
  const status = run?.status ?? result?.status ?? null;
  // A pending cancel request (`cancelRequestedAtMs` set but the run not yet
  // flipped to 'cancelled') suppresses the autopsy INTENTIONALLY: the operator
  // is already tearing the run down, so a task error that races the not-yet-
  // effected cancel is not worth spending agent tokens to investigate. This is
  // a deliberate suppression, unlike the human-denied path below which is
  // scoped to the actual terminal-cause node.
  if (status === "cancelled" || status === "canceled" || run?.cancelRequestedAtMs != null) {
    return "cancelled";
  }
  if (status === "waiting-quota" || result?.status === "waiting-quota") {
    return "quota-parked";
  }
  // The caller reaches here because the *process* reported a failed result, but
  // that is not the same as the RUN having failed. An `up` process that dies or
  // is interrupted while its run sits on a gate reports failure for a run whose
  // ledger status is still a parked one — and autopsying that produces a report
  // whose own conclusion is "nothing failed, just resume it". Trust the ledger
  // over the process: a run parked on a human, an event, or a timer has not
  // terminated, so there is nothing to explain yet. Whichever process later
  // carries the run to a terminal state classifies it then.
  //
  // Scoped to a status positively read from the LEDGER (`run.status`), never the
  // caller's `result.status`, which is "failed" by definition at the call site.
  // An unreadable run keeps the fail-open `"task-error"` path below.
  if (run && PARKED_RUN_STATUSES.has(String(run.status))) {
    return "not-terminal";
  }
  // listAllDecidedApprovals (NOT listDecidedApprovals): a human-denied gate
  // leaves its node in state "failed", which the node-state='pending' filter
  // of listDecidedApprovals would exclude. why-diagnosis reads the all-variant
  // for the same reason.
  const decided = await Promise.resolve(adapter.listAllDecidedApprovals(runId)).catch(() => []);
  const humanDenials = decided.filter((row) => row.status === "denied" && row.decidedBy !== CANCEL_APPROVAL_AUTHOR);
  // Scope the denial to the run's TERMINAL CAUSE, not its whole history. A
  // denial only failed the run when its own gate node is in state "failed"
  // (the default onDeny:'fail'). A denial with onDeny:'continue'/'skip'
  // (engine.js shouldExecuteDeniedApprovalTask) lets the run continue past the
  // gate — its node ends 'finished'/'skipped', so a LATER genuine task error
  // is the real terminal cause and must still be autopsied. A run-global
  // "any historical denial" check would wrongly suppress that autopsy.
  for (const denial of humanDenials) {
    let targetNodeId = denial.nodeId;
    let targetIteration = denial.iteration;
    try {
      const request = JSON.parse(denial.requestJson ?? "null");
      if (
        request?.kind === "ReplayUnsafeApproval" &&
        request.runId === runId &&
        typeof request.nodeId === "string" &&
        Number.isSafeInteger(request.iteration)
      ) {
        targetNodeId = request.nodeId;
        targetIteration = request.iteration;
      }
    } catch {
      // Malformed request metadata falls back to the approval row target.
    }
    const node = await Promise.resolve(adapter.getNode(runId, targetNodeId, targetIteration)).catch(() => undefined);
    if (node?.state === "failed") {
      return "human-denied";
    }
  }
  return "task-error";
}
