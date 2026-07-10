/**
 * Pure domain model for the /monitor gateway UI (see ./monitor.tsx).
 *
 * Everything here is framework-free and unit-tested in
 * apps/cli/tests/monitor-ui-model.test.ts. The React entry stays thin: it
 * renders what these functions derive.
 */

// ---------------------------------------------------------------------------
// Tolerant readers. Gateway rows arrive snake_case or camelCase depending on
// the backend adapter, node-output hooks return either the row or
// `{ row, schema, status }`, and array/object fields may arrive JSON-encoded.
// These helpers encode those real quirks — keep them with any reuse.
// ---------------------------------------------------------------------------

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : value == null ? undefined : String(value);
}

export function asNumber(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) ? n : undefined;
}

export function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === "string" && value.trim().startsWith("[")) {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

/** Node-output hooks return either the row directly or `{ row, schema, status }`. */
export function rowOf(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  if (isRecord(value.row)) return value.row;
  // A {status, row: null, schema} envelope means the node produced no output —
  // never render the envelope itself as if it were the row.
  if ("row" in value || "schema" in value) return null;
  return value;
}

/** Why a failed node failed, from the getNodeOutput envelope's `error` field. */
export function nodeErrorOf(
  value: unknown,
): { name?: string; code?: string; message: string; attempt?: number } | null {
  if (!isRecord(value) || !isRecord(value.error)) return null;
  const message = asString(value.error.message);
  if (!message) return null;
  const name = asString(value.error.name);
  const code = asString(value.error.code);
  return {
    ...(name ? { name } : {}),
    ...(code ? { code } : {}),
    message,
    ...(typeof value.error.attempt === "number" ? { attempt: value.error.attempt } : {}),
  };
}

/**
 * Quota-park details from a run row's `errorJson` — the engine writes
 * `{quotaBlockedCount, resetAtMs?, blocked?: [{nodeId, resetAtMs?, message?}]}`
 * there when it parks a run as waiting-quota. `blocked` is absent on runs
 * parked by older engines.
 */
export function quotaInfoOf(row: Record<string, unknown>): {
  blockedCount: number;
  resetAtMs?: number;
  blocked: Array<{ nodeId: string; message?: string }>;
} | null {
  if (asString(row.status) !== "waiting-quota") return null;
  const raw = asString(pick(row, "errorJson", "error_json"));
  const empty = { blockedCount: 0, blocked: [] as Array<{ nodeId: string; message?: string }> };
  if (!raw) return empty;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return empty;
  }
  if (!isRecord(parsed)) return empty;
  const blocked = asArray(parsed.blocked)
    .filter(isRecord)
    .map((entry) => ({
      nodeId: asString(entry.nodeId) ?? "(unknown node)",
      ...(asString(entry.message) ? { message: asString(entry.message) } : {}),
    }));
  const resetAtMs = asNumber(parsed.resetAtMs);
  return {
    blockedCount: asNumber(parsed.quotaBlockedCount) ?? blocked.length,
    ...(resetAtMs !== undefined ? { resetAtMs } : {}),
    blocked,
  };
}

/**
 * The events worth a human's attention: node/run lifecycle transitions,
 * approvals, human requests, signals, and quota parks. Everything else
 * (agent chatter, heartbeats, frames, per-token traces) is volume, not
 * signal — the event log defaults to this filter with an "all" escape hatch.
 */
const NOTABLE_EVENT_PATTERN =
  /^(Node(Started|Finished|Failed|Retrying|Skipped|Cancelled|WaitingApproval)|Run[A-Z]|Approval|Human|Signal|Quota)/;

export function isNotableEvent(name: string): boolean {
  return NOTABLE_EVENT_PATTERN.test(name);
}

/** Read a field by camelCase or snake_case (gateway rows vary by backend). */
export function pick(row: Record<string, unknown>, camel: string, snake: string): unknown {
  return row[camel] ?? row[snake];
}

// ---------------------------------------------------------------------------
// Status tones. Color is state, never decoration: every lifecycle status maps
// to one of five tones consumed via `.tone-*` classes (one shared pill/dot).
// ---------------------------------------------------------------------------

export type Tone = "running" | "ok" | "waiting" | "failed" | "idle";

export function normalizeStatus(status: string | undefined): string {
  return (status ?? "").trim().toLowerCase().replaceAll("_", "-");
}

export function toneForStatus(status: string | undefined): Tone {
  const s = normalizeStatus(status);
  if (s === "running" || s === "in-progress" || s === "continued" || s === "recovering") return "running";
  if (s.startsWith("waiting") || s === "paused" || s === "pending" || s === "queued") return "waiting";
  if (s === "finished" || s === "succeeded" || s === "ok" || s === "success") return "ok";
  if (s === "failed" || s === "error" || s === "stale" || s === "orphaned") return "failed";
  if (s === "cancelled" || s === "canceled" || s === "skipped") return "idle";
  // Unknown statuses read as live so in-flight runs surface instead of vanishing.
  return "running";
}

export function labelForStatus(status: string | undefined): string {
  const s = normalizeStatus(status);
  return s === "" ? "unknown" : s;
}

// ---------------------------------------------------------------------------
// Run rows: grouping, filtering, sorting.
// ---------------------------------------------------------------------------

export type RunRow = {
  runId: string;
  workflowKey?: string;
  status?: string;
  createdAtMs?: number;
  startedAtMs?: number;
  finishedAtMs?: number;
};

export type RunGroup = "attention" | "active" | "completed" | "failed" | "cancelled";

export const GROUP_ORDER: readonly RunGroup[] = ["attention", "active", "completed", "failed", "cancelled"];

export const GROUP_TITLES: Record<RunGroup, string> = {
  attention: "Needs attention",
  active: "Active",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
};

export function groupForStatus(status: string | undefined): RunGroup {
  const s = normalizeStatus(status);
  if (s.startsWith("waiting") || s === "paused") return "attention";
  if (s === "finished" || s === "succeeded") return "completed";
  if (s === "failed" || s === "stale" || s === "orphaned") return "failed";
  if (s === "cancelled" || s === "canceled") return "cancelled";
  // running / continued / recovering / unknown → active, so nothing vanishes.
  return "active";
}

export type GroupedRuns = { group: RunGroup; title: string; runs: RunRow[] };

/** Group + order runs for the rail: attention first, newest first within a group. */
export function groupRuns(runs: readonly RunRow[]): GroupedRuns[] {
  const byGroup = new Map<RunGroup, RunRow[]>();
  for (const run of runs) {
    const group = groupForStatus(run.status);
    const list = byGroup.get(group);
    if (list) list.push(run);
    else byGroup.set(group, [run]);
  }
  const out: GroupedRuns[] = [];
  for (const group of GROUP_ORDER) {
    const list = byGroup.get(group);
    if (!list || list.length === 0) continue;
    list.sort((a, b) => (b.createdAtMs ?? 0) - (a.createdAtMs ?? 0));
    out.push({ group, title: GROUP_TITLES[group], runs: list });
  }
  return out;
}

export type RunFilter = { text: string; status: string; workflow: string };

export function filterRuns(runs: readonly RunRow[], filter: RunFilter): RunRow[] {
  const text = filter.text.trim().toLowerCase();
  return runs.filter((run) => {
    if (filter.status !== "all" && labelForStatus(run.status) !== filter.status) return false;
    if (filter.workflow !== "all" && (run.workflowKey ?? "unknown") !== filter.workflow) return false;
    if (
      text &&
      !run.runId.toLowerCase().includes(text) &&
      !(run.workflowKey ?? "").toLowerCase().includes(text)
    ) {
      return false;
    }
    return true;
  });
}

export function workflowOptions(runs: readonly RunRow[]): string[] {
  return Array.from(new Set(runs.map((run) => run.workflowKey ?? "unknown"))).sort();
}

export function statusOptions(runs: readonly RunRow[]): string[] {
  return Array.from(new Set(runs.map((run) => labelForStatus(run.status)))).sort();
}

// ---------------------------------------------------------------------------
// Lifecycle predicates + progress.
// ---------------------------------------------------------------------------

export function isTerminalStatus(status: string | undefined): boolean {
  const s = normalizeStatus(status);
  return s === "finished" || s === "succeeded" || s === "failed" || s === "cancelled" || s === "canceled";
}

export function isCancellable(status: string | undefined): boolean {
  return !isTerminalStatus(status);
}

export function isResumable(status: string | undefined): boolean {
  const s = normalizeStatus(status);
  return s === "failed" || s === "cancelled" || s === "canceled" || s === "stale" || s === "orphaned" || s === "paused";
}

export type RunProgress = { done: number; failed: number; total: number; fraction: number };

/**
 * Node progress from `getRun`'s `summary` (a `Record<nodeState, count>` built
 * server-side). Null when there is nothing meaningful to show.
 */
export function runProgress(summary: unknown): RunProgress | null {
  if (!isRecord(summary)) return null;
  let done = 0;
  let failed = 0;
  let total = 0;
  for (const [state, raw] of Object.entries(summary)) {
    const count = asNumber(raw) ?? 0;
    if (count <= 0) continue;
    total += count;
    const s = normalizeStatus(state);
    if (s === "finished" || s === "skipped") done += count;
    else if (s === "failed" || s === "cancelled" || s === "canceled") failed += count;
  }
  if (total === 0) return null;
  return { done, failed, total, fraction: (done + failed) / total };
}

// ---------------------------------------------------------------------------
// Time formatting. Callers pass `now` explicitly so these stay pure and the
// UI can drive every label from one shared clock.
// ---------------------------------------------------------------------------

export function shortRunId(runId: string | undefined): string {
  return runId ? runId.slice(0, 8) : "—";
}

export function formatElapsed(startMs: number | undefined, endMs: number): string {
  if (!startMs || endMs <= startMs) return "0s";
  const totalSec = Math.floor((endMs - startMs) / 1000);
  const days = Math.floor(totalSec / 86_400);
  const hours = Math.floor((totalSec % 86_400) / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const secs = totalSec % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  if (mins > 0) return `${mins}m ${secs}s`;
  return `${secs}s`;
}

export function timeAgo(ms: number | undefined, now: number): string {
  if (!ms) return "—";
  const diff = now - ms;
  if (diff < 60_000) return "just now";
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** Approval wait-time escalation: calm under 5m, warn under 30m, then urgent. */
export function waitTone(waitedMs: number): "idle" | "waiting" | "failed" {
  if (waitedMs < 5 * 60_000) return "idle";
  if (waitedMs < 30 * 60_000) return "waiting";
  return "failed";
}

// ---------------------------------------------------------------------------
// Event log lines.
// ---------------------------------------------------------------------------

export type EventLine = { seq: number; name: string; detail: string };

const EVENT_DETAIL_MAX = 160;

/** Compact one-line rendering for a gateway event frame. */
export function formatEventLine(frame: { event?: string; seq?: number; payload?: unknown }): EventLine {
  const name = asString(frame.event) ?? "event";
  const seq = asNumber(frame.seq) ?? 0;
  const payload = isRecord(frame.payload) ? frame.payload : {};
  const parts: string[] = [];
  const nodeId = asString(pick(payload, "nodeId", "node_id"));
  if (nodeId) parts.push(nodeId);
  const state = asString(payload.state) ?? asString(payload.status);
  if (state) parts.push(state);
  if (name === "task.output" || name.startsWith("agent.")) {
    const text =
      asString(payload.text) ??
      asString(payload.message) ??
      asString(payload.summary) ??
      (payload.output !== undefined ? JSON.stringify(payload.output) : undefined);
    if (text) parts.push(text.length > EVENT_DETAIL_MAX ? `${text.slice(0, EVENT_DETAIL_MAX)}…` : text);
  }
  if (name === "run.completed") {
    const status = asString(payload.status);
    if (status && !parts.includes(status)) parts.push(status);
  }
  return { seq, name, detail: parts.join(" · ") };
}

// ---------------------------------------------------------------------------
// Execution tree expansion.
// ---------------------------------------------------------------------------

export type TreeNodeLike = {
  key?: string;
  id?: string;
  status?: string;
  children?: readonly TreeNodeLike[] | null;
};

export function treeNodeKey(node: TreeNodeLike): string {
  return node.key ?? node.id ?? "";
}

/** Containers this many levels deep render expanded even when nothing is live. */
const AUTO_EXPAND_DEPTH = 2;

/**
 * Default-expanded node keys: every ancestor of a running, waiting, or failed
 * node (the paths the operator is looking for), plus shallow container nodes
 * so a finished run still shows its tasks instead of one collapsed row. User
 * toggles override these in the component.
 */
export function autoExpandKeys(root: TreeNodeLike | null): Set<string> {
  const expanded = new Set<string>();
  if (!root) return expanded;
  const visit = (node: TreeNodeLike, ancestors: string[]): void => {
    const tone = toneForStatus(node.status);
    if (tone === "running" || tone === "waiting" || tone === "failed") {
      for (const key of ancestors) expanded.add(key);
    }
    const key = treeNodeKey(node);
    if (ancestors.length < AUTO_EXPAND_DEPTH && (node.children?.length ?? 0) > 0) {
      expanded.add(key);
    }
    for (const child of node.children ?? []) visit(child, [...ancestors, key]);
  };
  expanded.add(treeNodeKey(root));
  visit(root, []);
  return expanded;
}

/** True when any descendant (not the node itself) failed — for rollup badges. */
export function hasFailedDescendant(node: TreeNodeLike): boolean {
  for (const child of node.children ?? []) {
    if (toneForStatus(child.status) === "failed" || hasFailedDescendant(child)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Output pretty-printing.
// ---------------------------------------------------------------------------

const OUTPUT_MAX_CHARS = 20_000;

/** Render a node output value as displayable text (JSON-decoded when possible). */
export function formatOutputValue(value: unknown): string {
  let out: string;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        out = JSON.stringify(JSON.parse(trimmed), null, 2);
      } catch {
        out = value;
      }
    } else {
      out = value;
    }
  } else if (value === undefined) {
    out = "";
  } else {
    try {
      out = JSON.stringify(value, null, 2) ?? String(value);
    } catch {
      out = String(value);
    }
  }
  return out.length > OUTPUT_MAX_CHARS ? `${out.slice(0, OUTPUT_MAX_CHARS)}\n… (truncated)` : out;
}
