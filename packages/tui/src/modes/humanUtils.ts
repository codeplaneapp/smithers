import type { GatewayRunNode, GatewayApprovalRow } from "@smithers-orchestrator/gateway-client";

/**
 * Everything the inspector needs to render a pending durable human-task request.
 * A flat prop bag so the presentational banner stays pure.
 */
export type HumanRequestUiState = {
  title: string;
  prompt?: string;
  /** The run id, surfaced so the banner can tell the user the exact CLI command. */
  runId: string;
};

/**
 * True when a node is a durable HumanTask (kind `human`). HumanTask nodes back a
 * pending row in `_smithers_human_requests` whose typed answer the run reads when
 * it resumes — and that typed value is supplied ONLY by `answerHumanRequest`
 * (`smithers human`), which the gateway exposes no RPC for. The gateway's
 * `submitApproval` can flip the node's approval gate but NOT supply the value, so
 * the resume bridge keeps the node `waiting-approval` (see
 * deferred-state-bridge: approval `approved` + human request `pending` →
 * waiting). Approving/denying such a node from the monitor would therefore
 * STRAND the run, so we surface CLI guidance instead of approve/deny controls.
 */
export function isHumanTaskNode(node: GatewayRunNode | null | undefined): boolean {
  return node?.kind === "human";
}

/**
 * Statuses under which a HumanTask node can no longer be holding a pending
 * human request — everything else (waiting, queued, running, …) may be parked
 * on one, because the derived per-node status only reflects the run-level
 * blocked pointer: a HumanTask parked while a parallel sibling still runs
 * leaves run.status "running" and derives "queued" for the human node.
 */
const HUMAN_SETTLED_STATUSES = new Set(["done", "completed", "ok", "failed", "error", "cancelled", "canceled"]);

/**
 * True when a focused HumanTask node may still be waiting on a typed answer,
 * regardless of the derived per-node status. Used to keep polling for the
 * pending approval row (which is what authoritatively flips the inspector to
 * the CLI-guidance banner) even while the run itself is still "running".
 */
export function mayAwaitHumanInput(node: GatewayRunNode | null | undefined): boolean {
  if (!isHumanTaskNode(node)) return false;
  return !HUMAN_SETTLED_STATUSES.has(node?.status ?? "");
}

/**
 * Build the human-request banner state for a focused HumanTask node. The
 * pending approval row is AUTHORITATIVE: `listApprovals` returns only
 * status='requested' rows, and a parked HumanTask in a running/parallel run
 * derives a non-"waiting" node status (e.g. "queued") because per-node status
 * comes solely from the run-level blocked pointer. Keying the guard on the
 * derived status alone showed such nodes the approve/deny banner, whose one
 * keystroke [a]/[d] strands or fails the task. Request rows can also arrive
 * after the run tree snapshot, so a waiting node WITHOUT a row still gets the
 * safe CLI guidance.
 */
export function buildHumanRequestUi(
  node: GatewayRunNode | null | undefined,
  approval: GatewayApprovalRow | undefined,
  runId: string,
): HumanRequestUiState | null {
  if (!node || !isHumanTaskNode(node)) return null;
  if (!approval && node.status !== "waiting") return null;
  return {
    title: approval?.requestTitle ?? node?.name ?? "Human input required",
    prompt: approval?.requestSummary,
    runId,
  };
}
