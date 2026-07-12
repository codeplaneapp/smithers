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
): { name?: string; code?: string; message: string; attempt?: number; agent?: string } | null {
  if (!isRecord(value) || !isRecord(value.error)) return null;
  const message = asString(value.error.message);
  if (!message) return null;
  const name = asString(value.error.name);
  const code = asString(value.error.code);
  // Agent errors embed the acting agent as `Agent "<id>" (engine, model=…)`.
  // Surface engine+model on the banner — "which agent hit the quota" should
  // not require reading the message body.
  const agentMatch = /Agent "[^"]*" \(([^)]+)\)/.exec(message);
  const agent = agentMatch?.[1]?.replace(/model=/, "").replace(", ", " · ");
  return {
    ...(name ? { name } : {}),
    ...(code ? { code } : {}),
    message,
    ...(typeof value.error.attempt === "number" ? { attempt: value.error.attempt } : {}),
    ...(agent ? { agent } : {}),
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

// ---------------------------------------------------------------------------
// Run health diagnosis. One always-on verdict per run — green/yellow/red, what
// the run is doing right now, and the concrete fix — recomputed live from
// gateway state. Deterministic on purpose: it must keep working during the
// exact provider outages and quota walls it reports on.
// ---------------------------------------------------------------------------

export type RunDiagnosis = {
  tone: "ok" | "warn" | "crit";
  headline: string;
  detail: string;
  fix: string;
  /** One-click remedy the monitor can offer (wired to a gateway RPC). */
  action?: "resume";
};

/** Logical task rows only — structural containers carry numeric snapshot keys. */
function taskRows(
  treeNodes: ReadonlyArray<{ id?: unknown; status?: unknown }>,
): Array<{ id: string; status: string }> {
  const seen = new Map<string, string>();
  for (const node of treeNodes) {
    const id = asString(node.id);
    const status = asString(node.status) ?? "queued";
    if (!id || /^\d+$/.test(id)) continue;
    // Loop iterations repeat the logical id; the busiest status wins.
    const rank: Record<string, number> = { queued: 0, cancelled: 1, waiting: 2, ok: 3, failed: 4, running: 5 };
    const existing = seen.get(id);
    if (!existing || (rank[status] ?? 0) >= (rank[existing] ?? 0)) seen.set(id, status);
  }
  return [...seen.entries()].map(([id, status]) => ({ id, status }));
}

export function diagnoseRun(input: {
  runId: string;
  status: string | undefined;
  healthState?: string;
  quota: ReturnType<typeof quotaInfoOf>;
  approvalsCount: number;
  treeNodes: ReadonlyArray<{ id?: unknown; status?: unknown }>;
  failureSample?: { nodeId: string; message: string } | null;
}): RunDiagnosis {
  const status = input.status ?? "";
  const tasks = taskRows(input.treeNodes);
  const failed = tasks.filter((task) => task.status === "failed");
  const running = tasks.filter((task) => task.status === "running");
  const done = tasks.filter((task) => task.status === "ok").length;
  const total = tasks.length;
  const guardTrips = failed.filter((task) => task.id.startsWith("guard:") || /:(queue-)?guard$/.test(task.id));
  const sample = input.failureSample?.message
    ? ` Latest failure (${input.failureSample.nodeId}): ${input.failureSample.message.slice(0, 220)}`
    : "";
  const progress = total ? `${done}/${total} tasks done` : "no tasks yet";

  if (guardTrips.length) {
    return {
      tone: "crit",
      headline: "Main guard tripped — the run stopped itself",
      detail: `${guardTrips.map((task) => task.id).join(", ")} failed: the repo root left main or an agent wrote outside its worktree.${sample}`,
      fix: `Do NOT resume yet. Inspect with \`smithers node ${input.runId} <nodeId>\`, fix the checkout, then \`smithers up --resume ${input.runId}\`.`,
    };
  }
  if (status === "failed" || status === "errored") {
    return {
      tone: "crit",
      headline: "Run failed",
      detail: `${failed.length} task(s) exhausted retries; ${progress}.${sample}`,
      fix: `\`smithers inspect ${input.runId}\` for the cause, \`smithers retry-task\` to recover a node, then resume.`,
    };
  }
  if (status === "cancelled" || status === "canceled") {
    return {
      tone: "warn",
      headline: "Run cancelled",
      detail: `Stopped deliberately at ${progress}.`,
      fix: `Start a fresh run, or \`smithers replay\` from a checkpoint if the work should continue.`,
    };
  }
  if (status === "waiting-quota") {
    const blocked = input.quota?.blocked ?? [];
    const who = blocked.length
      ? ` Blocked: ${blocked.slice(0, 3).map((entry) => entry.nodeId).join(", ")}${blocked.length > 3 ? "…" : ""}.`
      : "";
    const why = blocked[0]?.message ? ` ${blocked[0].message.slice(0, 220)}` : sample;
    return {
      tone: "warn",
      headline: "Parked on provider quota — nothing is wrong",
      detail: `${input.quota?.blockedCount ?? 0} task(s) hit a usage limit; ${progress}.${who}${why}`,
      fix: `It auto-resumes when the window resets. To go sooner: add capacity (\`smithers agents add\`), then resume.`,
      action: "resume",
    };
  }
  if (status === "waiting-approval" || input.approvalsCount > 0) {
    return {
      tone: "warn",
      headline: `Waiting on you — ${Math.max(input.approvalsCount, 1)} approval(s) pending`,
      detail: `The run is parked until a human decides; ${progress}.`,
      fix: "Approve or deny in the approvals panel (or `smithers approve <runId> --node <id>`).",
    };
  }
  if (input.healthState === "stale" || input.healthState === "orphaned" || input.healthState === "recovering") {
    return {
      tone: "warn",
      headline: "Engine heartbeat is stale",
      detail: `The run claims to be ${status || "active"} but its engine has gone quiet; ${progress}.`,
      fix: `Resuming re-attaches an engine (or \`smithers supervise\` to auto-heal).`,
      action: "resume",
    };
  }
  if (failed.length && (status === "running" || status.startsWith("waiting"))) {
    return {
      tone: "warn",
      headline: `Running with ${failed.length} failed task(s)`,
      detail: `${progress}; ${running.length} running. Failed: ${failed.slice(0, 4).map((task) => task.id).join(", ")}${failed.length > 4 ? "…" : ""}.${sample}`,
      fix: `Failed tasks were continue-on-fail or await retry. \`smithers retry-task\` recovers one; the run keeps going meanwhile.`,
    };
  }
  if (status === "running") {
    const active = running.slice(0, 3).map((task) => task.id).join(", ");
    return {
      tone: "ok",
      headline: "Healthy — running",
      detail: `${progress}; ${running.length} task(s) in flight${active ? ` (${active}${running.length > 3 ? "…" : ""})` : ""}.`,
      fix: "No action needed.",
    };
  }
  if (status === "finished" || status === "succeeded" || status === "completed") {
    return failed.length
      ? {
          tone: "warn",
          headline: "Finished with failures",
          detail: `${progress}; ${failed.length} task(s) failed: ${failed.slice(0, 4).map((task) => task.id).join(", ")}.${sample}`,
          fix: `Review the failed nodes; \`smithers retry-task\` + resume if they should complete.`,
        }
      : {
          tone: "ok",
          headline: "Completed",
          detail: `${progress}.`,
          fix: "No action needed.",
        };
  }
  return {
    tone: "warn",
    headline: status ? `Status: ${status}` : "Status unknown",
    detail: progress + ".",
    fix: `\`smithers why ${input.runId}\` explains what it is waiting for.`,
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

/**
 * The agent's actual work, on top of the notable set: tool calls, agent
 * chat/output, node output, committed frames, trace summaries, and token
 * usage. Covers both the persisted SmithersEvent names (PascalCase) and the
 * gateway's mapped wire names (dotted) — the event collection carries both.
 */
const ACTIVITY_EVENT_PATTERN =
  /^(NodeOutput|FrameCommitted|AgentTraceSummary|TokenUsageReported|AgentEvent|AgentTraceEvent|ToolCall|node\.(started|finished|failed|retrying|skipped|cancelled|waiting_approval|waiting_timer)|run\.(completed|time_travel_jumped)|approval\.|task\.output|agent\.(event|trace|trace_summary))/;

/**
 * Classify an event name into the log's three views. "notable" is the
 * human-decision set above; "activity" adds the agent's visible work;
 * "chatter" is the rest (heartbeats, session bookkeeping, snapshots).
 */
export function eventViewFor(name: string): "notable" | "activity" | "chatter" {
  if (NOTABLE_EVENT_PATTERN.test(name)) return "notable";
  if (ACTIVITY_EVENT_PATTERN.test(name)) return "activity";
  return "chatter";
}

export function isNotableEvent(name: string): boolean {
  return eventViewFor(name) === "notable";
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
// Gateway connection states. One view per transport status: the header badge
// and the runs-rail banner render these verbatim, so every degraded state gets
// the same treatment (short label + one-line guidance + optional recovery
// action) and the copy stays testable without a DOM. Unauthorized is a
// credentials problem, never a network one — its copy must not read like an
// outage.
// ---------------------------------------------------------------------------

export type ConnectionView = {
  /** Short state name for the badge. Guidance lives in `hint`, not the label. */
  label: string;
  tone: Tone;
  /** Pulse the dot only when the link is really streaming. */
  pulse: boolean;
  /** One-line operator guidance shown beside the badge for degraded states. */
  hint: string | null;
  /** Manual recovery control offered alongside the transport's auto-retry. */
  action: { kind: "reload"; label: string } | null;
  /** Empty-rail banner for states where the run list is stale or blocked. */
  banner: { title: string; detail: string } | null;
};

export function connectionViewFor(status: string | undefined): ConnectionView {
  switch (status) {
    case "online":
      return { label: "Live", tone: "ok", pulse: true, hint: null, action: null, banner: null };
    case "offline":
      return {
        label: "Offline",
        tone: "failed",
        pulse: false,
        hint: "Showing last-known data — reconnecting automatically.",
        action: { kind: "reload", label: "Refresh" },
        banner: {
          title: "Can't reach the Smithers gateway.",
          detail:
            "This tab's gateway isn't responding — it may have been restarted on another port. " +
            "It reconnects automatically once the gateway is back; otherwise refresh, or re-open with smithers monitor.",
        },
      };
    case "unauthorized":
      return {
        label: "Unauthorized",
        tone: "failed",
        pulse: false,
        hint: "Credentials or permissions are required — re-open with smithers monitor to mint a fresh token.",
        action: null,
        banner: {
          title: "This page isn't authorized for the gateway.",
          detail:
            "Credentials or permissions are required — the page's gateway token is missing, expired, or revoked. " +
            "Re-open with smithers monitor to mint a fresh one.",
        },
      };
    // idle (no traffic yet) reads as connecting: the first queries are in flight.
    default:
      return {
        label: "Connecting…",
        tone: "waiting",
        pulse: false,
        hint: "Queries are still pending — results appear once the gateway responds.",
        action: null,
        banner: null,
      };
  }
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
  /** Node-state summary; getRun attaches it, plain listRuns rows omit it. */
  summary?: unknown;
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
// Landing-view runs table pagination. The gateway's listRuns filter has no
// offset/cursor (see ListRunsRequest in packages/gateway), so the table
// paginates client-side over the fetched window.
// ---------------------------------------------------------------------------

export const RUNS_PAGE_SIZE = 100;

export type PaginatedRuns<T> = { pageRows: T[]; page: number; pageCount: number; total: number };

/**
 * Slice `rows` into 1-based pages of `pageSize`, clamping `page` into range so
 * a stale page (filters shrank the list) still renders a real page. An empty
 * list is a single empty page.
 */
export function paginateRuns<T>(rows: readonly T[], page: number, pageSize: number): PaginatedRuns<T> {
  const size = Math.max(1, Math.floor(pageSize));
  const total = rows.length;
  const pageCount = Math.max(1, Math.ceil(total / size));
  const requested = Number.isFinite(page) ? Math.floor(page) : 1;
  const clamped = Math.min(Math.max(1, requested), pageCount);
  const start = (clamped - 1) * size;
  return { pageRows: rows.slice(start, start + size), page: clamped, pageCount, total };
}

// ---------------------------------------------------------------------------
// Lifecycle predicates + progress.
// ---------------------------------------------------------------------------

/**
 * A node earns an AI "what happened" recap only once it is settled: finished,
 * failed, or cancelled. Live nodes change under the narrator (and bypass the
 * gateway summary cache), and pending/waiting nodes have nothing to narrate;
 * skipped nodes never ran at all.
 */
export function nodeSummaryEligible(status: string | undefined): boolean {
  const s = normalizeStatus(status);
  if (s === "skipped") return false;
  if (s === "cancelled" || s === "canceled") return true;
  const tone = toneForStatus(status);
  return tone === "ok" || tone === "failed";
}

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

/** Pause is a graceful, resumable park — only an actively running run can take it. */
export function isPausable(status: string | undefined): boolean {
  return normalizeStatus(status) === "running";
}

/**
 * Whether the inspector offers "Retry task" for a node: the node must have
 * failed, and the run must not be actively executing — the gateway's
 * retryTask (like `smithers retry-task`) refuses to reset state under a live
 * engine, so a disabled button with that reason beats a doomed request.
 */
export function canRetryTask(nodeStatus: string | undefined, runStatus: string | undefined): boolean {
  if (toneForStatus(nodeStatus) !== "failed") return false;
  const s = normalizeStatus(runStatus);
  return !(s === "running" || s === "waiting-approval" || s === "waiting-event" || s === "waiting-timer");
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

/** Snippets stay single-line and about this long so the log reads as a column. */
const EVENT_SNIPPET_MAX = 120;

/** Collapse any value to a one-line, ~120-char snippet (undefined when empty). */
function snippet(value: unknown): string | undefined {
  let text: string | undefined;
  if (typeof value === "string") text = value;
  else if (value !== undefined && value !== null) {
    try {
      text = JSON.stringify(value);
    } catch {
      text = String(value);
    }
  }
  const oneLine = text?.replace(/\s+/g, " ").trim();
  if (!oneLine) return undefined;
  return oneLine.length > EVENT_SNIPPET_MAX ? `${oneLine.slice(0, EVENT_SNIPPET_MAX)}…` : oneLine;
}

/** Human-readable error text from an event's `error` field (object or string). */
function errorSnippet(error: unknown): string | undefined {
  if (isRecord(error)) return snippet(asString(error.message) ?? error);
  return typeof error === "string" ? snippet(error) : undefined;
}

/**
 * Per-event extra detail parts. Payloads arrive in two shapes: persisted
 * SmithersEvent rows (PascalCase name, the whole event as payload) and the
 * gateway's mapped wire frames (dotted name, trimmed payload) — each branch
 * accepts both.
 */
function eventDetailParts(name: string, payload: Record<string, unknown>): Array<string | undefined> {
  // Tool-call lifecycle: the tool's name is the story.
  if (name === "ToolCallStarted" || name === "ToolCallFinished") {
    return [asString(payload.toolName) ?? "tool"];
  }
  // Canonical agent trace: tool name + compact args/result hint, or a text snippet.
  if (name === "AgentTraceEvent" || name === "agent.trace") {
    const trace = isRecord(payload.trace) ? payload.trace : {};
    const kind = isRecord(trace.event) ? asString(trace.event.kind) : undefined;
    const tracePayload = isRecord(trace.payload) ? trace.payload : {};
    const toolName = asString(tracePayload.toolName);
    if (toolName) {
      const hint = snippet(tracePayload.argsPreview) ?? snippet(tracePayload.resultPreview);
      return [kind, toolName, tracePayload.isError === true ? "error" : undefined, hint];
    }
    return [kind, snippet(tracePayload.text)];
  }
  // Raw agent CLI stream: started/action/completed with titles and answers.
  if (name === "AgentEvent" || name === "agent.event") {
    const inner = isRecord(payload.event) ? payload.event : {};
    const type = asString(inner.type);
    const engine = asString(payload.engine) ?? asString(inner.engine);
    if (type === "action") {
      const action = isRecord(inner.action) ? inner.action : {};
      const label = [asString(inner.phase), asString(action.kind)].filter(Boolean).join(" ");
      return [engine, label || "action", snippet(action.title) ?? snippet(inner.message)];
    }
    if (type === "completed") {
      return [engine, inner.ok === false ? "failed" : "completed", snippet(inner.answer) ?? errorSnippet(inner.error)];
    }
    if (type === "started") return [engine, "started", snippet(inner.title)];
    return [engine, type];
  }
  // Session transcript bookkeeping: just say which transcript row arrived.
  if (name === "AgentSessionEvent" || name === "agent.session") {
    const transcript = isRecord(payload.transcript) ? payload.transcript : {};
    const rowType = isRecord(transcript.event) ? asString(transcript.event.rowType) : undefined;
    return ["transcript", rowType];
  }
  // End-of-attempt trace summary: which agent/model and how well we captured it.
  if (name === "AgentTraceSummary" || name === "agent.trace_summary") {
    const summary = isRecord(payload.summary) ? payload.summary : {};
    return [
      asString(summary.model) ?? asString(summary.agentFamily),
      asString(summary.captureMode),
      asString(summary.traceCompleteness),
    ];
  }
  if (name === "TokenUsageReported") {
    const cacheRead = asNumber(payload.cacheReadTokens);
    return [
      asString(payload.model),
      `in ${asNumber(payload.inputTokens) ?? 0}`,
      `out ${asNumber(payload.outputTokens) ?? 0}`,
      cacheRead !== undefined ? `cache ${cacheRead}` : undefined,
    ];
  }
  if (name === "FrameCommitted") {
    return [`frame ${asNumber(payload.frameNo) ?? "?"}`, asString(payload.trigger)];
  }
  // Agent stdout/stderr chunks. Persisted rows carry `text`, wire frames `output`.
  if (name === "NodeOutput" || name === "task.output") {
    const stream = asString(payload.stream);
    return [stream === "stderr" ? "stderr" : undefined, snippet(payload.text ?? payload.output)];
  }
  // run.completed carries both the live `state` and the final `status`; the
  // final status is the verdict, so surface it even when a state was shown.
  if (name === "run.completed") {
    return [asString(payload.status), errorSnippet(payload.error)];
  }
  if (name === "NodeFailed" || name === "node.failed" || name === "RunFailed") {
    return [errorSnippet(payload.error)];
  }
  return [];
}

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
  for (const part of eventDetailParts(name, payload)) {
    if (part && !parts.includes(part)) parts.push(part);
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

export type XmlTreeNode = TreeNodeLike & {
  name?: string;
  kind?: string;
  iteration?: number;
  children?: readonly XmlTreeNode[] | null;
};

function escapeXmlAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
}

function xmlElementName(node: XmlTreeNode): string {
  const kind = (node.kind ?? "node").replace(/[^a-zA-Z0-9_.-]/g, "");
  if (!kind) return "Node";
  return kind.charAt(0).toUpperCase() + kind.slice(1);
}

/**
 * The execution tree as indented XML — the same shape the engine renders and
 * commits per frame, so the toggle reads like React DevTools' element view.
 * Works on whatever tree the panel is showing, including scrubbed frames.
 */
export function treeToXml(node: XmlTreeNode | null | undefined, depth = 0): string {
  if (!node) return "";
  const indent = "  ".repeat(depth);
  const attrs = [
    node.id ? ` id="${escapeXmlAttr(String(node.id))}"` : "",
    node.name && node.name !== node.id ? ` name="${escapeXmlAttr(String(node.name))}"` : "",
    node.status ? ` status="${escapeXmlAttr(String(node.status))}"` : "",
    typeof node.iteration === "number" && node.iteration > 0 ? ` iteration="${node.iteration}"` : "",
  ].join("");
  const element = xmlElementName(node);
  const children = (node.children ?? []).filter(Boolean);
  if (children.length === 0) return `${indent}<${element}${attrs} />`;
  const inner = children.map((child) => treeToXml(child, depth + 1)).join("\n");
  return `${indent}<${element}${attrs}>\n${inner}\n${indent}</${element}>`;
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
// Frame scrubber (the Execution panel's time-travel view).
// ---------------------------------------------------------------------------

/**
 * The valid scrub range for a run whose latest committed frame is
 * `latestFrameNo`. Engine frames are numbered from 1 (`persistDriverFrame`
 * pre-increments), so a run with frames scrubs 1..latest; only a zero-frame
 * run has the sentinel frame 0 (`getDevToolsSnapshot` rejects frame 0 once
 * real frames exist).
 */
export function frameScrubBounds(latestFrameNo: number): { min: number; max: number } {
  const max = Number.isFinite(latestFrameNo) ? Math.max(0, Math.floor(latestFrameNo)) : 0;
  return { min: max > 0 ? 1 : 0, max };
}

/**
 * Clamp a scrubber frame number into the valid range for `latestFrameNo`, so
 * prev/next buttons and the range input can never request a frame the gateway
 * cannot serve. Non-finite input falls back to the latest frame.
 */
export function clampFrameNo(frameNo: number, latestFrameNo: number): number {
  const { min, max } = frameScrubBounds(latestFrameNo);
  if (!Number.isFinite(frameNo)) return max;
  return Math.min(Math.max(min, Math.floor(frameNo)), max);
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

// ---------------------------------------------------------------------------
// Unified-diff detection and summary. Output fields sometimes carry a raw
// `git diff` / unified patch string, and the gateway's getNodeDiff returns
// per-file patches — both render as a proper diff view behind a collapsed
// summary ("N files, +X/−Y") instead of a wall of <pre> text.
// ---------------------------------------------------------------------------

/**
 * True when a string looks like a unified diff / git patch: a `diff --git`
 * header, or a `--- `/`+++ ` file-header pair followed by an `@@` hunk. The
 * pair+hunk requirement keeps prose that merely mentions "--- " honest.
 */
export function looksLikeUnifiedDiff(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const text = value.trimStart();
  if (text.startsWith("diff --git ")) return true;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length - 2; i += 1) {
    if (lines[i].startsWith("--- ") && lines[i + 1].startsWith("+++ ")) {
      for (let j = i + 2; j < lines.length; j += 1) {
        if (lines[j].startsWith("@@")) return true;
      }
      return false;
    }
  }
  return false;
}

export type DiffSummary = { files: number; added: number; removed: number };

/**
 * Count files and added/removed lines in a unified diff. File count prefers
 * `diff --git` headers; bare patches count `+++ ` headers instead. Header
 * lines (`+++`/`---`) never count as content changes.
 */
export function diffSummaryOf(patch: string): DiffSummary {
  let files = 0;
  let headers = 0;
  let added = 0;
  let removed = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) files += 1;
    else if (line.startsWith("+++ ")) headers += 1;
    else if (line.startsWith("+")) added += 1;
    else if (line.startsWith("---")) continue;
    else if (line.startsWith("-")) removed += 1;
  }
  return { files: files > 0 ? files : Math.max(1, headers), added, removed };
}

/** Merge per-file summaries (one getNodeDiff patch each) into one rollup. */
export function sumDiffSummaries(summaries: readonly DiffSummary[]): DiffSummary {
  return summaries.reduce(
    (acc, entry) => ({ files: acc.files + entry.files, added: acc.added + entry.added, removed: acc.removed + entry.removed }),
    { files: 0, added: 0, removed: 0 },
  );
}

/** "3 files, +120/−45" (singular-aware, U+2212 minus so −0 reads as a glyph). */
export function formatDiffSummary(summary: DiffSummary): string {
  return `${summary.files} ${summary.files === 1 ? "file" : "files"}, +${summary.added}/−${summary.removed}`;
}

/**
 * Split a multi-file patch into per-file chunks on `diff --git` boundaries.
 * Real bundles mix cleanly parseable files with ones @pierre/diffs' strict
 * hunk parser rejects (binary patches, odd counts) — per-file chunks let the
 * renderer pretty-print what parses and fall back to raw text for the rest,
 * instead of one bad file blanking the whole diff.
 */
export function splitPatchText(patch: string): string[] {
  const lines = patch.split("\n");
  const chunks: string[] = [];
  let current: string[] = [];
  for (const line of lines) {
    if (line.startsWith("diff --git ") && current.length > 0) {
      chunks.push(current.join("\n"));
      current = [];
    }
    current.push(line);
  }
  if (current.length > 0 && current.some((line) => line.trim().length > 0)) {
    chunks.push(current.join("\n"));
  }
  return chunks;
}

/** The patches array out of a getNodeDiff HTTP body (`{ok,data:{patches}}` or a bare bundle). */
export function diffPatchesOf(body: unknown): Array<{ path: string; diff: string }> {
  if (!isRecord(body)) return [];
  const bundle = isRecord(body.data) ? body.data : body;
  const rows = Array.isArray(bundle.patches) ? bundle.patches : [];
  const out: Array<{ path: string; diff: string }> = [];
  for (const row of rows) {
    if (!isRecord(row)) continue;
    const path = asString(row.path);
    const diff = asString(row.diff);
    if (!path || !diff) continue;
    out.push({ path, diff });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Timeline: the run's task executions as a chronological flat list, loops
// unrolled — one entry per (nodeId, iteration). Rows come from the gateway's
// GET /v1/api/runs/:id/node-states (the run's _smithers_nodes rows with each
// row's latest-attempt timing attached).
// ---------------------------------------------------------------------------

export type NodeStateRow = {
  nodeId: string;
  iteration: number;
  state: string;
  lastAttempt?: number;
  updatedAtMs?: number;
  label?: string;
  startedAtMs?: number;
  finishedAtMs?: number;
};

/** Rows out of the node-states HTTP body (`{ok,data:[…]}` or a bare array), snake/camel tolerant. */
export function nodeStateRowsOf(body: unknown): NodeStateRow[] {
  const data = isRecord(body) ? body.data : body;
  const rows = Array.isArray(data) ? data : [];
  const out: NodeStateRow[] = [];
  for (const raw of rows) {
    if (!isRecord(raw)) continue;
    const nodeId = asString(pick(raw, "nodeId", "node_id"));
    if (!nodeId) continue;
    const label = asString(raw.label);
    const lastAttempt = asNumber(pick(raw, "lastAttempt", "last_attempt"));
    const updatedAtMs = asNumber(pick(raw, "updatedAtMs", "updated_at_ms"));
    const startedAtMs = asNumber(pick(raw, "startedAtMs", "started_at_ms"));
    const finishedAtMs = asNumber(pick(raw, "finishedAtMs", "finished_at_ms"));
    out.push({
      nodeId,
      iteration: asNumber(raw.iteration) ?? 0,
      state: asString(raw.state) ?? "unknown",
      ...(lastAttempt !== undefined ? { lastAttempt } : {}),
      ...(updatedAtMs !== undefined ? { updatedAtMs } : {}),
      ...(label ? { label } : {}),
      ...(startedAtMs !== undefined ? { startedAtMs } : {}),
      ...(finishedAtMs !== undefined ? { finishedAtMs } : {}),
    });
  }
  return out;
}

export type TimelineEntry = NodeStateRow & {
  /** Stable row key: `nodeId#iteration`. */
  key: string;
  /** When the execution ended (finish time, else last state write for settled rows). */
  endMs?: number;
  /** Wall-clock duration; live rows measure against `nowMs`. */
  durationMs?: number;
};

/** States that mean the node never actually ran (no execution to place in time). */
const NEVER_RAN_STATES = new Set(["pending", "queued"]);

/**
 * Order node-state rows into the timeline: rows that actually started sort by
 * start time (loops unroll into one entry per iteration); never-run rows
 * (still pending/queued — every row carries an updatedAtMs from its insert,
 * which is NOT an execution time) sink to the end in id order. Duration is
 * only computed from a real start — a live row measures against `nowMs`, a
 * settled row against its finish (or last update as the honest fallback).
 */
export function buildTimeline(rows: readonly NodeStateRow[], nowMs: number): TimelineEntry[] {
  const sortKeys = new Map<string, number | undefined>();
  const entries = rows.map((row) => {
    const tone = toneForStatus(row.state);
    const settled = tone === "ok" || tone === "failed" || tone === "idle";
    const endMs = row.finishedAtMs ?? (settled ? row.updatedAtMs : undefined);
    const durationMs =
      row.startedAtMs !== undefined
        ? Math.max(0, (endMs ?? nowMs) - row.startedAtMs)
        : undefined;
    const key = `${row.nodeId}#${row.iteration}`;
    const neverRan = NEVER_RAN_STATES.has(normalizeStatus(row.state)) && row.startedAtMs === undefined;
    sortKeys.set(key, row.startedAtMs ?? (neverRan ? undefined : row.updatedAtMs));
    return {
      ...row,
      key,
      ...(endMs !== undefined ? { endMs } : {}),
      ...(durationMs !== undefined ? { durationMs } : {}),
    };
  });
  entries.sort((a, b) => {
    const aStart = sortKeys.get(a.key);
    const bStart = sortKeys.get(b.key);
    if (aStart === undefined && bStart === undefined) return a.key.localeCompare(b.key);
    if (aStart === undefined) return 1;
    if (bStart === undefined) return -1;
    if (aStart !== bStart) return aStart - bStart;
    return a.key.localeCompare(b.key);
  });
  return entries;
}

/** Compact duration for timeline rows: "—" without a start, else 4s / 2m 05s / 1h 3m. */
export function formatDurationMs(durationMs: number | undefined): string {
  if (durationMs === undefined) return "—";
  const totalSec = Math.floor(durationMs / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  if (mins < 60) return `${mins}m ${String(secs).padStart(2, "0")}s`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

// ---------------------------------------------------------------------------
// PTY hijack. The gateway reports which nodes have a resumable agent session
// (GET /v1/api/runs/:id/hijack-candidates, from persisted attempt meta) and
// serves an interactive hand-off over the /v1/pty/hijack websocket, which
// spawns `smithers hijack <runId> --target <nodeId>` in a real PTY. These
// helpers decide when the inspector shows the affordance and build the
// websocket URL; the terminal itself lives in ./monitor.tsx.
// ---------------------------------------------------------------------------

export type HijackCandidate = {
  nodeId: string;
  engine: string;
  mode: string;
};

/** Candidates out of the hijack-candidates HTTP body (`{ok,data:{candidates}}`). */
export function hijackCandidatesOf(body: unknown): HijackCandidate[] {
  if (!isRecord(body)) return [];
  const data = isRecord(body.data) ? body.data : body;
  const rows = Array.isArray(data.candidates) ? data.candidates : [];
  const out: HijackCandidate[] = [];
  for (const row of rows) {
    if (!isRecord(row)) continue;
    const nodeId = asString(row.nodeId);
    const engine = asString(row.engine);
    if (!nodeId || !engine) continue;
    out.push({ nodeId, engine, mode: asString(row.mode) ?? "native-cli" });
  }
  return out;
}

export function hijackCandidateForNode(
  candidates: readonly HijackCandidate[],
  nodeId: string | undefined,
): HijackCandidate | null {
  if (!nodeId) return null;
  return candidates.find((candidate) => candidate.nodeId === nodeId) ?? null;
}

export type HijackAction = { kind: "hijack" | "reopen"; label: string };

/**
 * Which hijack affordance the node inspector shows.
 *
 * - No recorded session for the node: none — the button is hidden.
 * - Run still running and the node is live: "Hijack" (a live hand-off: the
 *   engine parks the run and `smithers hijack` resumes the agent session).
 * - Run no longer running: "Reopen session" (post-mortem resume of the
 *   recorded session — works for finished AND failed nodes).
 * - Node finished but the run is still running: none. `smithers hijack`
 *   against a live run requests a hand-off of the WHOLE run, which is not
 *   what reopening an old node's session means; wait for the run to settle.
 */
export function hijackActionFor(
  runStatus: string | undefined,
  nodeLive: boolean,
  hasCandidate: boolean,
): HijackAction | null {
  if (!hasCandidate) return null;
  const runLive = normalizeStatus(runStatus) === "running";
  if (runLive && nodeLive) {
    return { kind: "hijack", label: "Hijack" };
  }
  // A settled node's recorded session stays reopenable even while the run is
  // live — post-morteming one lane must not wait for the whole fleet.
  return { kind: "reopen", label: "Reopen session" };
}

// ---------------------------------------------------------------------------
// Generic API envelope reader. Every simple-read gateway route answers
// `{ok, data: [...]}`; some tools hand the bare array around instead.
// ---------------------------------------------------------------------------

/** Rows out of a gateway list HTTP body (`{ok,data:[…]}` or a bare array). */
export function dataRowsOf(body: unknown): unknown[] {
  if (Array.isArray(body)) return body;
  if (isRecord(body) && Array.isArray(body.data)) return body.data;
  return [];
}

// ---------------------------------------------------------------------------
// Prometheus text parsing. The gateway serves its metrics as Prometheus
// exposition text at /metrics; the monitor computes glanceable operator stats
// (latency percentiles, counters) from ONE scrape client-side instead of
// shipping a charting stack.
// ---------------------------------------------------------------------------

export type PromSample = { name: string; labels: Record<string, string>; value: number };

export type PromScrape = {
  /** Metric name → declared type ("counter" | "gauge" | "histogram" | …). */
  types: Record<string, string>;
  samples: PromSample[];
};

/**
 * Parse a `key="value",…` label segment (the part between `{` and `}`).
 * Handles the exposition-format escapes inside quoted values: `\\`, `\"`,
 * and `\n`. Returns null when the segment does not parse — the caller drops
 * that line instead of guessing.
 */
function parsePromLabels(segment: string): Record<string, string> | null {
  const labels: Record<string, string> = {};
  let i = 0;
  while (i < segment.length) {
    // label name
    let eq = segment.indexOf("=", i);
    if (eq === -1) return null;
    const name = segment.slice(i, eq).trim();
    if (!name) return null;
    if (segment[eq + 1] !== '"') return null;
    let j = eq + 2;
    let value = "";
    let closed = false;
    while (j < segment.length) {
      const ch = segment[j];
      if (ch === "\\") {
        const next = segment[j + 1];
        value += next === "n" ? "\n" : next === '"' ? '"' : next === "\\" ? "\\" : `\\${next ?? ""}`;
        j += 2;
        continue;
      }
      if (ch === '"') {
        closed = true;
        j += 1;
        break;
      }
      value += ch;
      j += 1;
    }
    if (!closed) return null;
    labels[name] = value;
    // skip separator comma (and stray spaces)
    while (j < segment.length && (segment[j] === "," || segment[j] === " ")) j += 1;
    i = j;
  }
  return labels;
}

function parsePromValue(raw: string): number | undefined {
  if (raw === "+Inf" || raw === "Inf") return Infinity;
  if (raw === "-Inf") return -Infinity;
  if (raw === "NaN") return NaN;
  const n = Number(raw);
  return Number.isNaN(n) && raw !== "NaN" ? undefined : n;
}

/**
 * Parse Prometheus exposition text into typed samples. Tolerant by design:
 * malformed lines are skipped (an operator readout must not blank on one odd
 * series), `# TYPE` comments feed the types map, other comments are ignored,
 * and an optional trailing timestamp on a sample line is dropped.
 */
export function parsePrometheusText(text: string): PromScrape {
  const types: Record<string, string> = {};
  const samples: PromSample[] = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith("#")) {
      const typeMatch = /^# TYPE (\S+) (\S+)/.exec(line);
      if (typeMatch) types[typeMatch[1]] = typeMatch[2];
      continue;
    }
    let name: string;
    let labels: Record<string, string> = {};
    let rest: string;
    const braceStart = line.indexOf("{");
    if (braceStart !== -1) {
      // Escaped quotes make a naive lastIndexOf("}") wrong only when a label
      // VALUE contains "}" after the real close — find the true closing brace
      // by scanning quote state instead.
      let inQuotes = false;
      let braceEnd = -1;
      for (let i = braceStart + 1; i < line.length; i += 1) {
        const ch = line[i];
        if (inQuotes) {
          if (ch === "\\") i += 1;
          else if (ch === '"') inQuotes = false;
        } else if (ch === '"') inQuotes = true;
        else if (ch === "}") {
          braceEnd = i;
          break;
        }
      }
      if (braceEnd === -1) continue;
      name = line.slice(0, braceStart);
      const parsed = parsePromLabels(line.slice(braceStart + 1, braceEnd));
      if (parsed === null) continue;
      labels = parsed;
      rest = line.slice(braceEnd + 1).trim();
    } else {
      const space = line.indexOf(" ");
      if (space === -1) continue;
      name = line.slice(0, space);
      rest = line.slice(space + 1).trim();
    }
    if (!name) continue;
    const value = parsePromValue(rest.split(/\s+/)[0] ?? "");
    if (value === undefined) continue;
    samples.push({ name, labels, value });
  }
  return { types, samples };
}

/**
 * Prometheus-style histogram quantile from cumulative `le` buckets (already
 * sorted ascending by this function). Linear interpolation inside the target
 * bucket; a quantile that lands in the `+Inf` bucket honestly reports the
 * highest finite bucket bound (there is no upper edge to interpolate toward).
 * Returns undefined when the histogram has no observations.
 */
export function histogramQuantile(
  quantile: number,
  buckets: ReadonlyArray<{ le: number; count: number }>,
): number | undefined {
  if (buckets.length === 0) return undefined;
  const sorted = [...buckets].sort((a, b) => a.le - b.le);
  const total = sorted[sorted.length - 1].count;
  if (!Number.isFinite(total) || total <= 0) return undefined;
  const rank = Math.min(Math.max(quantile, 0), 1) * total;
  let prevCount = 0;
  let prevLe = 0;
  for (const bucket of sorted) {
    if (bucket.count >= rank && bucket.count > prevCount) {
      if (!Number.isFinite(bucket.le)) return prevLe;
      const fraction = (rank - prevCount) / (bucket.count - prevCount);
      return prevLe + (bucket.le - prevLe) * fraction;
    }
    prevCount = bucket.count;
    if (Number.isFinite(bucket.le)) prevLe = bucket.le;
  }
  return prevLe;
}

export type HistogramStat = {
  /** Joined group-label values, e.g. "codex · gpt-5.3-codex". */
  key: string;
  labels: Record<string, string>;
  count: number;
  p50?: number;
  p95?: number;
};

/**
 * Group a histogram's `_bucket` samples by the given labels (summing across
 * every other label, e.g. operation/transport) and compute count + p50/p95
 * per group. Groups with zero observations are dropped — an all-zero
 * histogram (a freshly started gateway) yields []. Sorted by count desc.
 */
export function histogramStats(
  scrape: PromScrape,
  metricName: string,
  groupLabels: readonly string[],
): HistogramStat[] {
  const groups = new Map<string, { labels: Record<string, string>; byLe: Map<number, number> }>();
  for (const sample of scrape.samples) {
    if (sample.name !== `${metricName}_bucket`) continue;
    const leRaw = sample.labels.le;
    if (leRaw === undefined) continue;
    const le = parsePromValue(leRaw);
    if (le === undefined || Number.isNaN(le)) continue;
    const values = groupLabels.map((label) => sample.labels[label] ?? "");
    const key = values.filter(Boolean).join(" · ") || values.join(" · ");
    let group = groups.get(key);
    if (!group) {
      const labels: Record<string, string> = {};
      for (const label of groupLabels) {
        if (sample.labels[label] !== undefined) labels[label] = sample.labels[label];
      }
      group = { labels, byLe: new Map() };
      groups.set(key, group);
    }
    group.byLe.set(le, (group.byLe.get(le) ?? 0) + sample.value);
  }
  const out: HistogramStat[] = [];
  for (const [key, group] of groups) {
    const buckets = [...group.byLe.entries()].map(([le, count]) => ({ le, count }));
    const infBucket = buckets.find((bucket) => !Number.isFinite(bucket.le));
    const count = infBucket?.count ?? (buckets.length ? Math.max(...buckets.map((b) => b.count)) : 0);
    if (count <= 0) continue;
    const p50 = histogramQuantile(0.5, buckets);
    const p95 = histogramQuantile(0.95, buckets);
    out.push({
      key,
      labels: group.labels,
      count,
      ...(p50 !== undefined ? { p50 } : {}),
      ...(p95 !== undefined ? { p95 } : {}),
    });
  }
  out.sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
  return out;
}

/** Sum every sample of a counter/gauge that matches the given labels (subset match). */
export function metricValue(
  scrape: PromScrape,
  name: string,
  labels?: Record<string, string>,
): number | undefined {
  let sum = 0;
  let found = false;
  for (const sample of scrape.samples) {
    if (sample.name !== name) continue;
    if (labels && Object.entries(labels).some(([key, value]) => sample.labels[key] !== value)) continue;
    sum += sample.value;
    found = true;
  }
  return found ? sum : undefined;
}

/**
 * Every error-ish counter with a non-zero value: series whose name contains
 * "error" (plus quota/denied counters would drown signal, so just errors).
 * Bucket/sum/count histogram components are excluded.
 */
export function nonZeroErrorCounters(scrape: PromScrape): PromSample[] {
  return scrape.samples
    .filter(
      (sample) =>
        /error/i.test(sample.name) &&
        !/_bucket$|_sum$|_count$/.test(sample.name) &&
        Number.isFinite(sample.value) &&
        sample.value > 0,
    )
    .sort((a, b) => b.value - a.value);
}

/** "412ms" under a second, then "1.2s", "45s", then minutes — for latency stats. */
export function formatLatencyMs(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const sec = ms / 1000;
  if (sec < 10) return `${sec.toFixed(1)}s`;
  if (sec < 60) return `${Math.round(sec)}s`;
  const mins = Math.floor(sec / 60);
  return `${mins}m ${String(Math.round(sec % 60)).padStart(2, "0")}s`;
}

// ---------------------------------------------------------------------------
// Workspace ops stats — derived client-side from the runs list the monitor
// already fetches (listRuns rows carry status/heartbeat/finish timestamps but
// NO node summary, so anything needing per-node state is out of scope here).
// ---------------------------------------------------------------------------

export type OpsStats = {
  /** Runs whose status is actively running. */
  active: number;
  /** Runs parked on a human or an external wait (waiting-* / paused). */
  attention: number;
  /** Active runs with a fresh engine heartbeat — engines actually attached. */
  enginesLive: number;
  completedToday: number;
  failedToday: number;
};

/** A heartbeat older than this means the engine has gone quiet. */
const HEARTBEAT_FRESH_MS = 60_000;

export function opsStats(runs: ReadonlyArray<Record<string, unknown>>, nowMs: number): OpsStats {
  const dayStart = new Date(nowMs);
  dayStart.setHours(0, 0, 0, 0);
  const dayStartMs = dayStart.getTime();
  const stats: OpsStats = { active: 0, attention: 0, enginesLive: 0, completedToday: 0, failedToday: 0 };
  for (const run of runs) {
    const status = normalizeStatus(asString(run.status));
    const finishedAtMs = asNumber(pick(run, "finishedAtMs", "finished_at_ms"));
    const heartbeatAtMs = asNumber(pick(run, "heartbeatAtMs", "heartbeat_at_ms"));
    if (status === "running") {
      stats.active += 1;
      if (heartbeatAtMs !== undefined && nowMs - heartbeatAtMs < HEARTBEAT_FRESH_MS) {
        stats.enginesLive += 1;
      }
    } else if (status.startsWith("waiting") || status === "paused") {
      stats.attention += 1;
    }
    if (finishedAtMs !== undefined && finishedAtMs >= dayStartMs && finishedAtMs <= nowMs) {
      if (status === "finished" || status === "succeeded") stats.completedToday += 1;
      else if (status === "failed") stats.failedToday += 1;
    }
  }
  return stats;
}

// ---------------------------------------------------------------------------
// Crons. The gateway's cronList RPC re-lists each cron once per registered
// workflow that shares its DB adapter (and its per-row `workflow` guess falls
// back to the iterating workflow's key), so real responses carry hundreds of
// duplicates with misleading workflow names. Dedupe by cronId and derive the
// workflow label from the row's own workflowPath — the one field that is
// authoritative.
// ---------------------------------------------------------------------------

export type CronRow = {
  cronId: string;
  pattern: string;
  /** Workflow file stem from workflowPath (authoritative), e.g. "test-fortress-monitor". */
  workflow: string;
  workflowPath?: string;
  enabled: boolean;
  lastRunAtMs?: number;
  nextRunAtMs?: number;
  /** Human-readable message out of errorJson, when the last spawn failed. */
  error?: string;
};

function cronErrorMessage(raw: unknown): string | undefined {
  const text = asString(raw);
  if (!text) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    if (isRecord(parsed)) {
      return asString(parsed.message) ?? asString(parsed.error) ?? text;
    }
    return typeof parsed === "string" ? parsed : text;
  } catch {
    return text;
  }
}

export function cronRowsOf(body: unknown): CronRow[] {
  const seen = new Set<string>();
  const out: CronRow[] = [];
  for (const raw of dataRowsOf(body)) {
    if (!isRecord(raw)) continue;
    const cronId = asString(pick(raw, "cronId", "cron_id"));
    const pattern = asString(raw.pattern);
    if (!cronId || !pattern || seen.has(cronId)) continue;
    seen.add(cronId);
    const workflowPath = asString(pick(raw, "workflowPath", "workflow_path"));
    const stem = workflowPath
      ? (workflowPath.split("/").pop() ?? workflowPath).replace(/\.[jt]sx?$/, "")
      : undefined;
    const lastRunAtMs = asNumber(pick(raw, "lastRunAtMs", "last_run_at_ms"));
    const nextRunAtMs = asNumber(pick(raw, "nextRunAtMs", "next_run_at_ms"));
    const error = cronErrorMessage(pick(raw, "errorJson", "error_json"));
    out.push({
      cronId,
      pattern,
      workflow: stem ?? asString(raw.workflow) ?? "unknown",
      ...(workflowPath ? { workflowPath } : {}),
      enabled: raw.enabled === true || raw.enabled === 1,
      ...(lastRunAtMs !== undefined ? { lastRunAtMs } : {}),
      ...(nextRunAtMs !== undefined ? { nextRunAtMs } : {}),
      ...(error ? { error } : {}),
    });
  }
  // Soonest next fire first; disabled crons sink to the end.
  out.sort((a, b) => {
    if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
    return (a.nextRunAtMs ?? Infinity) - (b.nextRunAtMs ?? Infinity);
  });
  return out;
}

/** The enabled cron that fires next (for the ops strip's "next cron" card). */
export function nextCron(crons: readonly CronRow[]): CronRow | null {
  let best: CronRow | null = null;
  for (const cron of crons) {
    if (!cron.enabled || cron.nextRunAtMs === undefined) continue;
    // A nextRun in the past still counts ("due now") — the scheduler may lag.
    if (best === null || cron.nextRunAtMs < (best.nextRunAtMs ?? Infinity)) best = cron;
  }
  return best;
}

// ---------------------------------------------------------------------------
// Scores. `/v1/api/scores?runId=…` returns the run's `_smithers_scorers` rows:
// scorer results are normalized quality scores in [0, 1] (see the scorers
// package), so tones are threshold-based rather than pass/fail booleans.
// ---------------------------------------------------------------------------

export type ScoreRow = {
  nodeId: string;
  iteration: number;
  attempt: number;
  scorerId: string;
  scorerName: string;
  source?: string;
  score: number;
  reason?: string;
  scoredAtMs?: number;
};

export function scoreRowsOf(body: unknown): ScoreRow[] {
  const out: ScoreRow[] = [];
  for (const raw of dataRowsOf(body)) {
    if (!isRecord(raw)) continue;
    const nodeId = asString(pick(raw, "nodeId", "node_id"));
    const score = asNumber(raw.score);
    if (!nodeId || score === undefined) continue;
    const scorerId = asString(pick(raw, "scorerId", "scorer_id")) ?? "scorer";
    const scorerName = asString(pick(raw, "scorerName", "scorer_name")) ?? scorerId;
    const source = asString(raw.source);
    const reason = asString(raw.reason);
    const scoredAtMs = asNumber(pick(raw, "scoredAtMs", "scored_at_ms"));
    out.push({
      nodeId,
      iteration: asNumber(raw.iteration) ?? 0,
      attempt: asNumber(raw.attempt) ?? 0,
      scorerId,
      scorerName,
      ...(source ? { source } : {}),
      score,
      ...(reason ? { reason } : {}),
      ...(scoredAtMs !== undefined ? { scoredAtMs } : {}),
    });
  }
  // Newest first so the panel leads with the latest verdicts.
  out.sort((a, b) => (b.scoredAtMs ?? 0) - (a.scoredAtMs ?? 0));
  return out;
}

/** Threshold tones for a normalized [0,1] score: ≥0.8 ok, ≥0.5 warn, else failed. */
export function scoreTone(score: number): Tone {
  if (score >= 0.8) return "ok";
  if (score >= 0.5) return "waiting";
  return "failed";
}

/** "0.87" — normalized scores render with two decimals (integers stay bare). */
export function formatScore(score: number): string {
  if (!Number.isFinite(score)) return "—";
  return Number.isInteger(score) ? String(score) : score.toFixed(2);
}

export function scoresSummary(rows: readonly ScoreRow[]): { count: number; avg: number } {
  if (rows.length === 0) return { count: 0, avg: 0 };
  const sum = rows.reduce((acc, row) => acc + row.score, 0);
  return { count: rows.length, avg: sum / rows.length };
}

export function scoresForNode(rows: readonly ScoreRow[], nodeId: string | undefined): ScoreRow[] {
  if (!nodeId) return [];
  return rows.filter((row) => row.nodeId === nodeId);
}

// ---------------------------------------------------------------------------
// Accounts / memory facts / tickets — small ops-strip aggregates.
// ---------------------------------------------------------------------------

export type AccountRow = {
  label: string;
  provider: string;
  model?: string;
  /** Usable: has a config dir or an API key registered. */
  ready: boolean;
};

export function accountRowsOf(body: unknown): AccountRow[] {
  const out: AccountRow[] = [];
  for (const raw of dataRowsOf(body)) {
    if (!isRecord(raw)) continue;
    const label = asString(raw.label);
    const provider = asString(raw.provider);
    if (!label || !provider) continue;
    const model = asString(raw.model);
    out.push({
      label,
      provider,
      ...(model ? { model } : {}),
      ready: pick(raw, "hasConfigDir", "has_config_dir") === true || pick(raw, "hasApiKey", "has_api_key") === true,
    });
  }
  return out;
}

/** Ticket statuses that mean "no longer open". Unknown/absent statuses count as open. */
const CLOSED_TICKET_STATUSES = new Set(["done", "closed", "resolved", "cancelled", "canceled"]);

export function openTicketCount(body: unknown): number {
  let open = 0;
  for (const raw of dataRowsOf(body)) {
    if (!isRecord(raw)) continue;
    const status = asString(raw.status)?.trim().toLowerCase();
    if (!status || !CLOSED_TICKET_STATUSES.has(status)) open += 1;
  }
  return open;
}

/**
 * Websocket URL for the gateway's PTY hijack channel. Mirrors the transport
 * shape of smithers cloud terminals: binary frames are PTY bytes, text frames
 * are JSON control messages.
 */
export function ptyHijackUrl(
  origin: string,
  runId: string,
  nodeId: string | undefined,
  size: { cols: number; rows: number },
): string {
  const url = new URL("/v1/pty/hijack", origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("runId", runId);
  if (nodeId) url.searchParams.set("nodeId", nodeId);
  url.searchParams.set("cols", String(Math.max(2, Math.floor(size.cols) || 80)));
  url.searchParams.set("rows", String(Math.max(2, Math.floor(size.rows) || 24)));
  return url.toString();
}
