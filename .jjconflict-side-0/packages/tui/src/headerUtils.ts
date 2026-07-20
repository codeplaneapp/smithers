/**
 * Pure helpers backing the monitor's run header. Kept free of React/gateway so
 * the header is unit-testable with injected run data (no provider, no network).
 */

/** Run states where the run is actively making progress. */
const RUNNING_STATES = new Set(["running", "recovering", "resuming", "in-progress", "started"]);
/** Run states where the run is parked waiting on an external decision/event/timer/quota. */
const PAUSED_STATES = new Set([
  "waiting-approval",
  "waiting-event",
  "waiting-timer",
  "waiting-quota",
  "waiting",
  "blocked",
  "paused",
]);

/**
 * Paused check is ALSO prefix-based: the engine's run-status union (see
 * packages/db DB_RUN_ALLOWED_STATUSES) grows new `waiting-*` states over time
 * (waiting-quota shipped after this set was written), and every one of them is
 * "parked, will resume" — amber paused, never the grey unknown treatment.
 */
function isPausedStatus(status: string): boolean {
  return PAUSED_STATES.has(status) || status.startsWith("waiting-");
}
const FAILED_STATES = new Set(["failed", "errored", "error", "stale", "orphaned"]);
/**
 * User-cancelled runs are terminal but NOT failures: they are shown dim/grey, not
 * red, so a deliberate cancel doesn't read as an error. Kept out of FAILED_STATES.
 */
const CANCELLED_STATES = new Set(["cancelled", "canceled"]);
const DONE_STATES = new Set(["succeeded", "finished", "completed", "ok", "continued"]);

export function isRunningStatus(status: string): boolean {
  return RUNNING_STATES.has(status);
}

/** Status-dot color, sharing the run UI's palette. */
export function statusDotColor(status: string): string {
  if (RUNNING_STATES.has(status)) return "#00d7ff";
  if (isPausedStatus(status)) return "#ffaf00";
  if (FAILED_STATES.has(status)) return "#ff5f5f";
  if (DONE_STATES.has(status)) return "#00d787";
  // Cancelled: dim grey (terminal but not a failure). Distinct from the darker
  // `#555555` used for genuinely unknown states.
  if (CANCELLED_STATES.has(status)) return "#888888";
  return "#555555";
}

/** The live/paused indicator: `live` while progressing, `paused` while parked, else the literal state. */
export function runLiveLabel(status: string): { text: string; color: string } {
  if (RUNNING_STATES.has(status)) return { text: "live", color: "#00d787" };
  if (isPausedStatus(status)) return { text: "paused", color: "#ffaf00" };
  return { text: status, color: "#888888" };
}

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** `MM:SS` (or `HH:MM:SS` past an hour); `--:--` when the elapsed time is unknown. */
export function formatElapsed(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return "--:--";
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return h > 0 ? `${pad2(h)}:${pad2(m)}:${pad2(s)}` : `${pad2(m)}:${pad2(s)}`;
}

/** Show a run id whole unless it is genuinely long, then elide from the end. */
export function shortRunId(runId: string): string {
  return runId.length > 24 ? `${runId.slice(0, 21)}…` : runId;
}

/** Everything the header view renders, derived from the run row + the current time. */
export type RunHeaderData = {
  status: string;
  workflowKey?: string;
  runId: string;
  model?: string;
  /** ms the run has been going (frozen at completion for terminal runs); undefined when unknown. */
  elapsedMs?: number;
  live: boolean;
};

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}
function asNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/**
 * Shape a `getRun` row into header data. `elapsed` ticks against `nowMs` while
 * running and freezes at `finishedAtMs` once terminal. `model` is surfaced only
 * when the row actually carries one (never fabricated). While loading the run we
 * show a neutral `connecting` status.
 */
export function buildRunHeaderData(
  run: Record<string, unknown> | undefined,
  runId: string,
  nowMs: number,
  loading: boolean,
): RunHeaderData {
  const status = loading ? "connecting" : asString(run?.["status"]) ?? "unknown";
  const startedAt = asNumber(run?.["startedAtMs"]) ?? asNumber(run?.["createdAtMs"]);
  const finishedAt = asNumber(run?.["finishedAtMs"]);
  const end = finishedAt !== undefined ? finishedAt : nowMs;
  const elapsedMs = startedAt !== undefined ? Math.max(0, end - startedAt) : undefined;
  return {
    status,
    workflowKey: asString(run?.["workflowKey"]),
    runId,
    model: asString(run?.["model"]),
    elapsedMs,
    live: isRunningStatus(status),
  };
}
