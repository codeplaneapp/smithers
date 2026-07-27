/**
 * The approvals surface: the queue of pending approval gates plus the history of
 * resolved decisions, ported from the Swift ApprovalsView (the gate-inspection
 * pane that watches `<Approval>` nodes). One card and one canvas render the
 * live data; the Pending/History toggle mirrors the Swift `showHistory` pill.
 *
 * Pending gates are sourced LIVE from the gateway `approvals` collection via
 * `ApprovalsBridge` (`useGatewayApprovals()`), NOT from any in-app seed. The
 * decision History is OPTIMISTIC and client-only — `listApprovals` streams only
 * pending gates and the gateway does not persist decisions today, so History is
 * empty after a reload (accepted P1 gap; see `approvalsStore`). This module
 * holds only the pure types + helpers, unit-tested without a DOM against inline
 * fixtures (see approvalsDomain.test.ts).
 */

/** Where an approval was discovered. `synthetic` is the inspection fallback. */
export type ApprovalSource = "http" | "sqlite" | "exec" | "synthetic";

export type ApprovalStatus = "pending" | "approved" | "denied";

/** The two segments the approvals surface toggles between. */
export type ApprovalsTab = "pending" | "history";

/** One approval gate the engine paused on, with the metadata the detail shows. */
export type ApprovalGate = {
  id: string;
  runId: string;
  nodeId: string;
  /** The loop iteration the gate fired on, when the node is inside a loop. */
  iteration?: number;
  /** The workflow file the gate lives in. */
  workflowPath?: string;
  /** The gate's human name; falls back to `nodeId` when absent (Swift `gate ?? nodeId`). */
  gate?: string;
  status: ApprovalStatus;
  source: ApprovalSource;
  /** The decision context, a JSON string the detail pretty-prints. */
  payload?: string;
  requestedAtMs: number;
  resolvedAtMs?: number;
  resolvedBy?: string;
  note?: string;
  reason?: string;
};

/** A resolved gate, recorded in the History pane. `action` is the outcome. */
export type ApprovalDecision = {
  id: string;
  runId: string;
  nodeId: string;
  gate?: string;
  workflowPath?: string;
  iteration?: number;
  source: ApprovalSource;
  payload?: string;
  action: "approved" | "denied";
  requestedAtMs: number;
  resolvedAtMs: number;
  resolvedBy: string;
  note?: string;
  reason?: string;
};

/** The label a gate or decision shows: its gate name, falling back to nodeId. */
export function gateLabel(item: { gate?: string; nodeId: string }): string {
  return item.gate && item.gate.trim() !== "" ? item.gate : item.nodeId;
}

/** Short run id for the mono `Run: <8>` subline (Swift's prefix(8)). */
export function shortRunId(runId: string): string {
  return runId.slice(0, 8);
}

/** Keep only the gates still waiting on a decision (Swift filterPendingApprovals). */
export function filterPending(gates: ApprovalGate[]): ApprovalGate[] {
  return gates.filter((gate) => gate.status === "pending").sort((a, b) => a.requestedAtMs - b.requestedAtMs);
}

/** History newest-first by resolution time (most recent decision on top). */
export function orderHistory(decisions: ApprovalDecision[]): ApprovalDecision[] {
  return decisions.slice().sort((a, b) => b.resolvedAtMs - a.resolvedAtMs);
}

/**
 * Format the elapsed wait from a fixed `nowMs` anchor, porting Swift waitTime():
 * under a minute -> 'Ns'; under an hour -> 'Mm' or 'Mm Ss'; else 'Hh Mm'.
 * Negative spans (anchor before the request) clamp to 0.
 */
export function waitTime(requestedAtMs: number, nowMs: number): string {
  const totalSeconds = Math.max(0, Math.floor((nowMs - requestedAtMs) / 1000));
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }
  if (totalSeconds < 3600) {
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
  }
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  return `${hours}h ${minutes}m`;
}

/** Human-readable age band for an approval's live wait time. */
export function waitTimeState(requestedAtMs: number, nowMs: number): "fresh" | "warning" | "stale" {
  const minutes = Math.max(0, (nowMs - requestedAtMs) / 60000);
  if (minutes < 5) return "fresh";
  if (minutes <= 30) return "warning";
  return "stale";
}

/**
 * Escalate the wait-time badge tone by age, porting Swift waitTimeColor():
 * under 5 min -> 'is-fresh' (muted), 5–30 min -> 'is-warn', over 30 min ->
 * 'is-stale' (danger). The boundaries are inclusive of the lower band.
 */
export function waitTimeTone(requestedAtMs: number, nowMs: number): "is-fresh" | "is-warn" | "is-stale" {
  const state = waitTimeState(requestedAtMs, nowMs);
  if (state === "fresh") return "is-fresh";
  if (state === "warning") return "is-warn";
  return "is-stale";
}

/**
 * Pretty-print a payload as 2-space-indented JSON, porting Swift prettyJSON():
 * fall back to the raw string (trimmed) when it does not parse, and to an empty
 * string when the input is nullish.
 */
export function prettyJson(raw: string | undefined): string {
  if (raw === undefined) return "";
  const trimmed = raw.trim();
  if (trimmed === "") return "";
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return trimmed;
  }
}

/**
 * Format a millisecond timestamp deterministically as an ISO-style
 * `YYYY-MM-DD HH:MM:SS` in UTC. Uses Date only as a pure formatter over a fixed
 * seeded millis value — never `Date.now()` — so the rendered string is stable.
 */
export function formatTimestamp(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
  );
}

/** Pending + decided headline counts for the surface-sub and the card. */
export function summarizeApprovals(
  gates: ApprovalGate[],
  decisions: ApprovalDecision[],
): { pending: number; decided: number } {
  return { pending: filterPending(gates).length, decided: decisions.length };
}
