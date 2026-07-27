import { SmithersError } from "@smithers-orchestrator/errors/SmithersError";

const CHILD_WORKFLOW_SUSPENDING_STATUSES = new Set([
  "waiting-approval",
  "waiting-event",
  "waiting-timer",
  "waiting-quota",
  "paused",
]);

/**
 * @param {unknown} error
 * @returns {Record<string, unknown> | null}
 */
function findApprovalDenial(error) {
  const seen = new Set();
  let current = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const record = /** @type {Record<string, unknown>} */ (current);
    if (record.approved === false) return record;
    current = record.cause;
  }
  return null;
}

/**
 * @param {string} nodeId
 * @param {{ runId: string; status: string; error?: unknown }} result
 * @returns {SmithersError}
 */
export function createSubflowResultError(nodeId, result) {
  const suspending = CHILD_WORKFLOW_SUSPENDING_STATUSES.has(result.status);
  const denial = findApprovalDenial(result.error);
  const summary = suspending
    ? `Subflow ${nodeId} is waiting on child run ${result.runId} with status ${result.status}.`
    : denial
      ? `Subflow ${nodeId} failed because child run ${result.runId} denied an approval.`
      : `Subflow ${nodeId} failed because child run ${result.runId} ended with status ${result.status}.`;
  return new SmithersError("WORKFLOW_EXECUTION_FAILED", summary, {
    nodeId,
    status: result.status,
    childRunId: result.runId,
    ...(result.error === undefined ? {} : { childError: result.error }),
    ...(suspending ? { suspensionStatus: result.status } : {}),
    ...(suspending || denial || result.status === "cancelled" ? { failureRetryable: false } : {}),
  });
}
