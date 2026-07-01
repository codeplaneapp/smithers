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
 * Build the human-request banner state for a focused waiting HumanTask node.
 * Request rows can arrive after the run tree snapshot, so the row enriches the
 * banner when present but is not required to show the safe CLI guidance.
 */
export function buildHumanRequestUi(
  node: GatewayRunNode | null | undefined,
  approval: GatewayApprovalRow | undefined,
  runId: string,
): HumanRequestUiState | null {
  if (!node || !isHumanTaskNode(node) || node.status !== "waiting") return null;
  return {
    title: approval?.requestTitle ?? node?.name ?? "Human input required",
    prompt: approval?.requestSummary,
    runId,
  };
}
