/**
 * The shared run/feature status vocabulary. This is the single source of truth
 * consumed by StatusPill here and re-exported by
 * `@smthrs/gateway-ui` (which previously owned copies of these
 * helpers; consumer repos duplicated them again on top).
 */
import { tokens } from "./tokens";

/** Lowercases, trims, and normalizes `_` to `-` so status spellings compare. */
export function normalizeStatus(status: string | undefined): string {
  return (status ?? "").trim().toLowerCase().replaceAll("_", "-");
}

export type StatusClass = "ok" | "warn" | "bad" | "muted" | "run";

const STATUS_CLASS_COLORS: Readonly<Record<StatusClass, string>> = {
  ok: tokens.success,
  warn: tokens.warning,
  bad: tokens.destructive,
  muted: tokens.mutedForeground,
  run: tokens.primary,
};

const STATUS_CLASS_BY_STATUS = {
  fixed: "ok",
  /*
   * The rc.0 run vocabulary (`@smthrs/control` `RunStatus`): accepted,
   * running, parked, waiting-approval, cancelled, completed, failed. Only
   * `accepted` and `parked` were new; every other spelling below already had
   * a bucket, and every addition here is additive — no status changed tone.
   *
   * `accepted` is a run the control plane took and has not started: neutral,
   * like `queued`, because nothing is in flight yet. `parked` is a run
   * holding on something — an approval, an event, a timer, a quota — which is
   * the same "waiting on the world" tone every `waiting-*` status carries.
   */
  accepted: "muted",
  parked: "warn",
  /*
   * The run-card phases apps/ui renders beside the engine's own statuses. A
   * card is launching before the engine has a run to report, reconnecting
   * while the read path is down, quiet when a run stopped moving, stopped
   * when the human stopped watching, and no-capacity when the workspace could
   * not be provisioned.
   */
  launching: "run",
  reconnecting: "warn",
  quiet: "warn",
  stopped: "muted",
  "no-capacity": "warn",
  ready: "ok",
  done: "ok",
  finished: "ok",
  continued: "ok",
  succeeded: "ok",
  "succeeded-with-failures": "warn",
  success: "ok",
  ok: "ok",
  complete: "ok",
  completed: "ok",
  closed: "ok",
  produced: "ok",
  broken: "bad",
  blocked: "bad",
  failed: "bad",
  stalled: "bad",
  failure: "bad",
  error: "bad",
  denied: "bad",
  // A user-initiated cancel is a neutral outcome, not a failure. This matches
  // the styleguide's `.badge.cancelled` and gateway-ui's RunEventLog; parity
  // is pinned by tests/status-vocabulary-parity.test.ts.
  cancelled: "muted",
  canceled: "muted",
  stale: "bad",
  orphaned: "bad",
  running: "run",
  active: "run",
  current: "run",
  "in-progress": "run",
  inprogress: "run",
  working: "run",
  retrying: "run",
  streaming: "run",
  partial: "warn",
  "missing-tests": "warn",
  missing: "warn",
  waiting: "warn",
  "waiting-approval": "warn",
  "waiting-event": "warn",
  "waiting-timer": "warn",
  "waiting-quota": "warn",
  paused: "warn",
  recovering: "warn",
  queued: "muted",
  pending: "muted",
  open: "muted",
  todo: "muted",
  skipped: "muted",
} as const satisfies Readonly<Record<string, StatusClass>>;

/**
 * Token color aliases derived from the shared vocabulary. Class keys are the
 * canonical API; normalized status keys remain for gateway-ui compatibility.
 */
export const statusColors = Object.freeze(
  Object.fromEntries([
    ...Object.entries(STATUS_CLASS_COLORS),
    ...Object.entries(STATUS_CLASS_BY_STATUS).map(([status, tone]) => [status, STATUS_CLASS_COLORS[tone]]),
  ]),
) as Readonly<Record<string, string>> & Readonly<Record<StatusClass, string>>;

/** Bucket a status string into the badge tints. */
export function statusClass(status: string | undefined): StatusClass {
  const normalized = normalizeStatus(status);
  if (normalized.startsWith("waiting-")) return "warn";
  return STATUS_CLASS_BY_STATUS[normalized as keyof typeof STATUS_CLASS_BY_STATUS] ?? "muted";
}

/** Resolve any status alias through the shared class vocabulary to its token color. */
export function statusColor(status: string | undefined): string {
  return statusColors[statusClass(status)];
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
    accepted: "Accepted",
    parked: "Parked",
    launching: "Launching",
    reconnecting: "Reconnecting",
    // `quiet` is deliberately absent: the mechanical fallback already renders
    // "Quiet", which is the pill apps/ui's run card has always worn
    // (apps/ui CardFrames.test.tsx, "a quiet or stopped run card never wears a
    // Running pill"). A label entry here would change a rendered string, and
    // this table's Phase 4 additions are additive only.
    stopped: "Stopped",
    "no-capacity": "No capacity",
    ready: "Ready",
    done: "Done",
    finished: "Finished",
    continued: "Continued",
    succeeded: "Complete",
    "succeeded-with-failures": "Completed with failures",
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
    stalled: "Stalled",
    failure: "Failed",
    error: "Error",
    denied: "Denied",
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
  return (
    labels[normalized] ??
    normalized
      .split("-")
      .map((part) => (part ? `${part[0]!.toUpperCase()}${part.slice(1)}` : part))
      .join(" ")
  );
}

const TERMINAL_STATUSES = new Set([
  "ok",
  "success",
  "done",
  "finished",
  "continued",
  "succeeded",
  "succeeded-with-failures",
  "complete",
  "completed",
  "closed",
  "fixed",
  "failed",
  "stalled",
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
