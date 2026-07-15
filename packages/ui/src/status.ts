/**
 * The shared run/feature status vocabulary. This is the single source of truth
 * consumed by StatusPill here and re-exported by
 * `@smithers-orchestrator/gateway-ui` (which previously owned copies of these
 * helpers; consumer repos duplicated them again on top).
 */

/** Lowercases, trims, and normalizes `_` to `-` so status spellings compare. */
export function normalizeStatus(status: string | undefined): string {
  return (status ?? "").trim().toLowerCase().replaceAll("_", "-");
}

export type StatusClass = "ok" | "warn" | "bad" | "muted";

/** Bucket a status string into the four badge tints. */
export function statusClass(status: string | undefined): StatusClass {
  const normalized = normalizeStatus(status);
  if (["fixed", "ready", "done", "finished", "continued", "succeeded", "success", "ok", "complete", "completed", "closed"].includes(normalized)) return "ok";
  if (["broken", "blocked", "failed", "failure", "error", "cancelled", "canceled", "stale", "orphaned"].includes(normalized)) return "bad";
  if (
    ["partial", "missing-tests", "missing", "running", "pending", "queued", "waiting", "paused", "recovering", "todo", "open"].includes(normalized) ||
    normalized.startsWith("waiting-")
  ) return "warn";
  return "muted";
}

/** Human label for a status string ("waiting-approval" -> "Waiting for approval"). */
export function formatStatus(status: string | undefined): string {
  const normalized = normalizeStatus(status);
  if (!normalized) return "Unknown";
  const labels: Record<string, string> = {
    ok: "Complete",
    success: "Complete",
    complete: "Complete",
    completed: "Complete",
    fixed: "Fixed",
    ready: "Ready",
    done: "Done",
    finished: "Finished",
    continued: "Continued",
    succeeded: "Complete",
    running: "Running",
    pending: "Pending",
    queued: "Queued",
    waiting: "Waiting",
    "waiting-approval": "Waiting for approval",
    "waiting-event": "Waiting for event",
    "waiting-timer": "Waiting on timer",
    "waiting-quota": "Waiting on quota",
    paused: "Paused",
    partial: "Partial",
    "missing-tests": "Missing e2e",
    missing: "Missing",
    broken: "Broken",
    blocked: "Blocked",
    failed: "Failed",
    failure: "Failed",
    error: "Error",
    cancelled: "Cancelled",
    canceled: "Cancelled",
    skipped: "Skipped",
    todo: "Todo",
    open: "Open",
    closed: "Closed",
    recovering: "Recovering",
    stale: "Stale",
    orphaned: "Orphaned",
  };
  return labels[normalized] ?? normalized.split("-").map((part) => part ? `${part[0]!.toUpperCase()}${part.slice(1)}` : part).join(" ");
}

const TERMINAL_STATUSES = new Set([
  "ok",
  "success",
  "done",
  "finished",
  "continued",
  "succeeded",
  "complete",
  "completed",
  "closed",
  "fixed",
  "failed",
  "failure",
  "error",
  "cancelled",
  "canceled",
  "skipped",
]);

/**
 * Whether a run status is terminal (finished, failed, or cancelled -- nothing
 * left to stream). Useful for polling cutoffs and "still working" affordances.
 */
export function isTerminalRunStatus(status: string | undefined): boolean {
  return TERMINAL_STATUSES.has(normalizeStatus(status));
}
