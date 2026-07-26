/**
 * Durable (nodeId, iteration) fetch-target enumeration from run events.
 *
 * Why events, not the devtools tree: the run tree only reflects the CURRENT
 * frame — one row per structural position — so a loop advance replaces prior
 * iterations (see `packages/gateway-client/src/sync/reconcileSnapshotNodes.ts`)
 * and unmounted listeners (`dc-edit` / `dc-skip-preview` / `dc-poll`) drop out
 * entirely. Run events are append-only and durable: every node lifecycle
 * event persists the full engine payload (`nodeId` + `iteration`), so
 * replaying event history reconstructs every iteration a fresh mount would
 * otherwise lose (exec attempt history, signal rows, budget actuals).
 */

import { delegationTableForNodeId } from "./foldDelegation.ts";

export type DelegationFetchTarget = { nodeId: string; iteration: number };

/** The map key for one (nodeId, iteration) fetch target. */
export function delegationTargetKey(nodeId: string, iteration: number): string {
  return `${nodeId}\u0000${iteration}`;
}

/**
 * Node lifecycle event names in BOTH spellings: rows replayed from the durable
 * `_smithers_events` table carry the persisted engine type (`NodeFinished`,
 * payload = the full engine event incl. `iteration`), while live gateway wire
 * frames use dotted names (`node.finished`).
 */
const NODE_LIFECYCLE_EVENTS = new Set([
  "NodePending",
  "node.pending",
  "NodeStarted",
  "node.started",
  "NodeFinished",
  "node.finished",
  "NodeFailed",
  "node.failed",
  "NodeRetrying",
  "node.retrying",
  "NodeSkipped",
  "node.skipped",
  "NodeCancelled",
  "node.cancelled",
  "NodeWaitingApproval",
  "node.waiting_approval",
  "NodeWaitingEvent",
  "node.waiting_event",
  "NodeWaitingTimer",
  "node.waiting_timer",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Extract every delegation-relevant (nodeId, iteration) output-fetch target
 * from a batch of run events (durable history rows or live frames). Only
 * nodes with an output table are enumerated — approval-only phases
 * (`approve` / `approval-<i>`) surface through the approvals collection, not
 * `getNodeOutput`. Events without a usable iteration default to 0.
 */
export function delegationTargetsFromEvents(
  events: Iterable<{ event: string; payload?: unknown }>,
): Map<string, DelegationFetchTarget> {
  const targets = new Map<string, DelegationFetchTarget>();
  for (const { event, payload } of events) {
    if (!NODE_LIFECYCLE_EVENTS.has(event)) continue;
    if (!isRecord(payload)) continue;
    const nodeId = typeof payload.nodeId === "string" ? payload.nodeId : undefined;
    if (!nodeId || delegationTableForNodeId(nodeId) === null) continue;
    const raw = payload.iteration;
    const iteration = typeof raw === "number" && Number.isInteger(raw) && raw >= 0 ? raw : 0;
    targets.set(delegationTargetKey(nodeId, iteration), { nodeId, iteration });
  }
  return targets;
}
