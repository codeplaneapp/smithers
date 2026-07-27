import { useEffect } from "react";
import { useGatewayApprovals, useGatewayMutation } from "@smithers-orchestrator/gateway-react";
import { gatewayKeys, type GatewayApprovalRow } from "@smithers-orchestrator/gateway-client";
import { useLocalModeRefetch } from "../sync/useLocalModeRefetch";
import type { ApprovalGate } from "./approvals";
import { bindApprovalActions, syncSelection, useApprovalsStore } from "./approvalsStore";

/**
 * Bridge the live `approvals` gateway collection into the approvals store
 * (§3.A/§3.C.4 of docs/p1a-plan.md). The store can't call React hooks, so this
 * component mounted inside `SmithersCollectionsProvider` in `main.tsx` calls
 * `useGatewayApprovals()`, maps each `GatewayApprovalSummary` onto an
 * `ApprovalGate`, and pushes the result into the store (re-running the selection
 * sync so the detail pane stays populated as gates arrive/resolve). It also
 * installs the `submitApproval` RPC seam so the store's approve/deny drive the
 * REAL gateway mutation (reusing `GatewayRunInspector`'s invalidate keys).
 *
 * NOTE on the History gap: `listApprovals` streams ONLY pending gates — the
 * gateway does not persist APPROVED/REJECTED rows today — so the bridge only
 * ever feeds `gates`. `decisions` are populated optimistically client-side by
 * the store's approve/confirmDeny and are lost on reload (the History tab is
 * empty after a refresh). Accepted P1 gap (docs/p1a-plan.md §7 risk 4).
 */

const APPROVALS_PARAMS = { filter: { limit: 50 } } as const;

type SubmitApprovalVars = {
  runId: string;
  nodeId: string;
  iteration: number;
  decision: { approved: boolean; note?: string };
};

/**
 * Stable first-seen wait-anchor for gates that arrive with NO wire
 * `requestedAtMs`. The local-mode poll re-pulls every LOCAL_LIST_POLL_MS, each
 * pull re-mapping the row with a fresh `Date.now()`; coalescing a timestamp-less
 * gate to that per-poll now would re-stamp the anchor every tick, so the wait
 * badge would read `0s` forever (waitTime = nowMs - requestedAtMs = 0). Anchor
 * such a gate ONCE, keyed by its composite id, and reuse it across polls.
 */
const firstSeenAnchors = new Map<string, number>();

/** Test/boot helper: forget all first-seen wait anchors. */
export function resetApprovalWaitAnchors(): void {
  firstSeenAnchors.clear();
}

/** Drop anchors whose gate id is no longer in the live set (bounds the map). */
function pruneApprovalWaitAnchors(liveIds: readonly string[]): void {
  if (firstSeenAnchors.size === 0) return;
  const live = new Set(liveIds);
  for (const id of firstSeenAnchors.keys()) {
    if (!live.has(id)) firstSeenAnchors.delete(id);
  }
}

/**
 * Map a live `GatewayApprovalSummary` row onto the surface's `ApprovalGate`.
 * The composite id matches the `approvals` collection key
 * `${runId}:${nodeId}:${iteration}`. `requestedAtMs` is `number | null` on the
 * wire → a real value is used as-is; a null/absent one is anchored to a STABLE
 * first-seen timestamp (see `firstSeenAnchors`) so the wait advances across
 * polls instead of resetting. `requestTitle` may be absent → fall back to
 * `nodeId` (the existing `gate ?? nodeId` convention).
 */
export function toApprovalGate(row: GatewayApprovalRow, nowMs: number): ApprovalGate {
  const iteration = typeof row.iteration === "number" ? row.iteration : 0;
  const id = `${row.runId}:${row.nodeId}:${iteration}`;
  let requestedAtMs: number;
  if (typeof row.requestedAtMs === "number") {
    requestedAtMs = row.requestedAtMs;
    firstSeenAnchors.delete(id);
  } else {
    const existing = firstSeenAnchors.get(id);
    if (existing === undefined) {
      firstSeenAnchors.set(id, nowMs);
      requestedAtMs = nowMs;
    } else {
      requestedAtMs = existing;
    }
  }
  const gate = typeof row.requestTitle === "string" && row.requestTitle.trim() !== "" ? row.requestTitle : row.nodeId;
  const workflowPath =
    typeof row.workflowKey === "string" && row.workflowKey.trim() !== "" ? row.workflowKey : undefined;
  const summary =
    typeof row.requestSummary === "string" && row.requestSummary.trim() !== "" ? row.requestSummary : undefined;
  return {
    id: `${row.runId}:${row.nodeId}:${iteration}`,
    runId: row.runId,
    nodeId: row.nodeId,
    iteration,
    workflowPath,
    gate,
    status: "pending",
    source: "http",
    payload: summary,
    requestedAtMs,
  };
}

export function ApprovalsBridge() {
  const { data, loading, error, refetch } = useGatewayApprovals(APPROVALS_PARAMS);
  const submitApproval = useGatewayMutation<SubmitApprovalVars, unknown>("submitApproval", {
    invalidate: [gatewayKeys.approvals(APPROVALS_PARAMS), gatewayKeys.runs({})],
  });

  // Install the real RPC seam so the store's approve/confirmDeny submit live.
  useEffect(() => {
    bindApprovalActions({
      submit: (vars) => submitApproval.mutate(vars),
      refetch,
    });
  }, [submitApproval.mutate, refetch]);

  // LOCAL-MODE freshness: the `approvals` collection is pull-only (no stream),
  // so a gate reached anywhere after load — or one resolved from the per-run
  // gateway inspector (which invalidates a per-run key, not this global
  // `{filter:{limit:50}}` collection) — is never pushed here. Poll the small
  // `listApprovals` RPC on a modest interval (+ on focus/visibility) so
  // `/approvals` reflects a gate reached/resolved within ~LOCAL_LIST_POLL_MS,
  // no reload needed. This complements (does not replace) the own-mutation
  // refetch above. Local-mode only; the cloud path streams via Electric (P5)
  // and this poll is removed there (see useLocalModeRefetch / LOCAL_LIST_POLL_MS).
  useLocalModeRefetch(refetch);

  // The collection only changes when gates arrive or resolve. Advance the
  // presentation clock independently so elapsed waits and their age bands stay
  // live while the pending rows themselves remain unchanged.
  useEffect(() => {
    const tick = () => useApprovalsStore.setState({ nowMs: Date.now() });
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    useApprovalsStore.setState((state) => {
      if (error) {
        return { loading: false, error: error.message || "The approvals service could not be reached." };
      }
      if (loading && (!data || data.length === 0)) {
        return { loading: true, error: null };
      }

      const nowMs = Date.now();
      const gates = data ? data.map((row) => toApprovalGate(row, nowMs)) : [];
      // Drop first-seen anchors for gates that are no longer pending so the
      // registry can't grow unbounded across a long session.
      pruneApprovalWaitAnchors(gates.map((gate) => gate.id));
      const selectedId = syncSelection({
        tab: state.tab,
        gates,
        decisions: state.decisions,
        selectedId: state.selectedId,
      });
      return { gates, selectedId, nowMs, loading: false, error: null };
    });
  }, [data, error, loading]);

  return null;
}
