/**
 * The runs LIST surface: a filterable, grouped roster of flow runs, ported
 * from multi's `src/runs/runsList.ts` (itself ported from the Swift
 * RunsView). Each `RunSummary` carries the status pill, progress, and
 * elapsed-badge fields a list row renders.
 *
 * The roster is sourced LIVE from the gateway `runs` collection via
 * `runsListBridge.ts` (`useGatewayRuns()`), NOT from any in-app seed. This
 * module holds only the pure types + filter/group/summarize reducers,
 * unit-tested without a DOM against inline fixtures.
 *
 * Two fields carry a deliberately NARROWED type versus multi's original:
 * `inferencePool` (multi's `InferencePool` resolves through the billing
 * types) and `completion` (multi's `RunVerdict` from `gateway/runVerdict.ts`,
 * which also carries UI-facing tone metadata out of scope here). ui-core must
 * stay dependency-light, so both are re-declared locally as their essential
 * shape rather than importing multi's billing/verdict modules.
 */
import type { NodeStatus } from "./Run.ts";
import type { StatusTone } from "./statusMeta.ts";

/** A run's lifecycle as the list models it (a superset of NodeStatus framing). */
export type RunListStatus = "running" | "waiting" | "finished" | "failed" | "cancelled" | "unknown";

/** The status filter: every RunListStatus plus the "all" pass-through. */
export type RunStatusFilter = "all" | RunListStatus;

/**
 * Seeded recency bucket. Wall-clock-free by design: the date filter matches by
 * bucket inclusion (Today ⊆ Week ⊆ Month ⊆ All) instead of comparing a stored
 * timestamp against `Date.now()`, so the demo is deterministic.
 */
export type AgeBucket = "today" | "week" | "month" | "older";

/** The date filter options the header offers, mapping to bucket inclusion. */
export type AgeFilter = "all" | "today" | "week" | "month";

/** The run-launch billing pool a row spent against — a lightweight local
 *  stand-in for multi's `InferencePool` (out of scope: billing types). */
export type RunInferencePool = "plan" | "byok";

/** The strict verifier verdict for a settled run — a lightweight local
 *  stand-in for multi's `RunVerdict` (out of scope: verdict tone metadata). */
export type RunVerdict = { state: "passed" | "failed" | "unknown"; paragraph: string };

/** One run in the roster, fully seeded — no derived-at-render timing. */
export type RunSummary = {
  id: string;
  /** 8-char hex, deterministic via FNV-1a shortHash of the title. */
  runId: string;
  workflowName: string;
  /**
   * The gateway workflow key the row belongs to, preserved from the live
   * `runs` collection so a list row can route to the gateway run inspector.
   * Absent on locally-seeded rows.
   */
  workflowKey?: string;
  model: string;
  status: RunListStatus;
  totalNodes: number;
  doneNodes: number;
  failedNodes: number;
  /** 0..1, derived from done/total in the seed. */
  progress: number;
  /** Static label like "2m14s"; "—" when not started. Never a ticking clock. */
  elapsedLabel: string;
  ageBucket: AgeBucket;
  /** Only on a waiting run: the node holding the gate. */
  blockedNodeLabel?: string;
  /** Only on a failed run: the one-line error. */
  errorText?: string;
  /**
   * True when the backend reported the run as accepted but NOT yet started
   * (raw status `queued`/`pending`). `runListStatusFromRaw` collapses those
   * onto `running` so the row stays in the ACTIVE group, which would otherwise
   * make queue depth invisible — this flag preserves the distinction.
   */
  queued?: boolean;
  /** The run-launch pool this row spent against, if known. */
  inferencePool?: RunInferencePool;
  /** The strict verifier paragraph for a settled delegated run, if one was emitted. */
  completion?: RunVerdict;
  /** Repo context captured when the run was launched, used by completion actions. */
  repoContext?: { owner: string; repo: string };
  /** Source bookmark/branch the run changed, if launch context knew it. */
  sourceBookmark?: string;
  /** Target bookmark/branch for opening a landing request. */
  targetBookmark?: string;
  /** Original workflow inputs, used to seed follow-up delegated runs. */
  launchInputs?: Record<string, unknown>;
};

/** FNV-1a, so a title maps to a stable 8-char run id without Math.random. */
export function shortHash(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** The first 8 chars of a run id, for the mono meta line (matches RunsView). */
export function shortRunId(runId: string): string {
  return runId.slice(0, 8);
}

/**
 * Collapse a backend's richer lifecycle vocabulary (gateway `listRuns`
 * statuses) onto the list's lifecycle tones. Unknown wire values stay neutral
 * instead of being counted as active execution.
 */
export function runListStatusFromRaw(status: string | undefined): RunListStatus {
  switch (status) {
    case "running":
    case "resumed":
    case "queued":
    case "pending":
      return "running";
    case "succeeded":
    case "finished":
    case "completed":
    case "continued":
    case "ok":
      return "finished";
    case "failed":
    case "errored":
      return "failed";
    case "cancelled":
    case "canceled":
      return "cancelled";
    case "waiting":
    case "blocked":
    case "paused":
      return "waiting";
    default:
      return status?.startsWith("waiting-") ? "waiting" : "unknown";
  }
}

/**
 * Whether a RAW backend status means "accepted but not yet started" — the
 * queue-depth signal `runListStatusFromRaw` deliberately erases (queued rows
 * render in the ACTIVE group). Callers use this to set `RunSummary.queued`.
 */
export function isQueuedRawStatus(status: string | undefined): boolean {
  return status === "queued" || status === "pending";
}

/** Map a list status to a NodeStatus the shared StatusPill understands. */
export function runStatusToNode(status: RunListStatus): NodeStatus {
  switch (status) {
    case "running":
      return "running";
    case "waiting":
      return "waiting";
    case "finished":
      return "ok";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    case "unknown":
      return "unknown";
  }
}

/** The tone a run row colors with — color is state, never decoration. */
export function runStatusTone(status: RunListStatus): StatusTone {
  switch (status) {
    case "running":
      return "running";
    case "waiting":
      return "waiting";
    case "finished":
      return "ok";
    case "failed":
      return "failed";
    case "cancelled":
      return "idle";
    case "unknown":
      return "idle";
  }
}

/** Human label for a run status, used on the pill (RunsView statusLabel). */
export function runStatusLabel(status: RunListStatus): string {
  switch (status) {
    case "running":
      return "running";
    case "waiting":
      return "waiting";
    case "finished":
      return "finished";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    case "unknown":
      return "unknown";
  }
}

/**
 * Whether a row should draw a progress bar: only active runs with known nodes
 * (RunsView shouldShowProgress = totalNodes > 0 && status in {running,waiting}).
 */
export function shouldShowProgress(run: RunSummary): boolean {
  return run.totalNodes > 0 && (run.status === "running" || run.status === "waiting");
}

/** The display name for a run, falling back like RunsView does. */
export function runDisplayName(run: RunSummary): string {
  const name = run.workflowName.trim();
  return name === "" ? "Unnamed flow" : name;
}

/**
 * The age buckets a date filter admits. Today ⊆ Week ⊆ Month ⊆ All, so a run
 * tagged "today" passes the Week and Month filters too, exactly like a real
 * recency window would include the most recent runs.
 */
const AGE_INCLUSION: Record<Exclude<AgeFilter, "all">, AgeBucket[]> = {
  today: ["today"],
  week: ["today", "week"],
  month: ["today", "week", "month"],
};

/** Whether a run's bucket falls inside the date filter's window. */
export function matchesAge(run: RunSummary, filter: AgeFilter): boolean {
  if (filter === "all") return true;
  return AGE_INCLUSION[filter].includes(run.ageBucket);
}

/** Whether a run matches the free-text search (workflowName OR runId substring). */
export function matchesSearch(run: RunSummary, search: string): boolean {
  const q = search.trim().toLowerCase();
  if (q === "") return true;
  return run.workflowName.toLowerCase().includes(q) || run.runId.toLowerCase().includes(q);
}

/** The four header filters, as one bag so the canvas passes a single value. */
export type RunFilters = {
  status: RunStatusFilter;
  workflow: string | "all";
  age: AgeFilter;
  search: string;
};

export const DEFAULT_FILTERS: RunFilters = {
  status: "all",
  workflow: "all",
  age: "all",
  search: "",
};

/** Whether any filter is off its default — drives the Clear link's visibility. */
export function hasActiveFilters(filters: RunFilters): boolean {
  return (
    filters.status !== "all" || filters.workflow !== "all" || filters.age !== "all" || filters.search.trim() !== ""
  );
}

/**
 * Apply every filter (status, workflow, date bucket, search), mirroring
 * RunsView.filteredRuns. Order is preserved (seed order = the engine's order).
 */
export function filterRuns(runs: RunSummary[], filters: RunFilters): RunSummary[] {
  return runs.filter((run) => {
    if (filters.status !== "all" && run.status !== filters.status) return false;
    if (filters.workflow !== "all" && run.workflowName !== filters.workflow) return false;
    if (!matchesAge(run, filters.age)) return false;
    if (!matchesSearch(run, filters.search)) return false;
    return true;
  });
}

/** The distinct workflow names in the seed, case-insensitive de-dup, first
 *  casing preserved, in first-seen order (RunsView workflow Menu). */
export function distinctWorkflows(runs: RunSummary[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const run of runs) {
    const key = run.workflowName.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(run.workflowName);
  }
  return out;
}

/** The grouped sections, in fixed render order (RunsView.runsList). */
export type RunGroupKey = "active" | "completed" | "failed" | "cancelled" | "unknown";

export type RunGroup = { key: RunGroupKey; label: string; runs: RunSummary[] };

const GROUP_ORDER: { key: RunGroupKey; label: string; admit: (s: RunListStatus) => boolean }[] = [
  { key: "active", label: "ACTIVE", admit: (s) => s === "running" || s === "waiting" },
  { key: "completed", label: "COMPLETED", admit: (s) => s === "finished" },
  { key: "failed", label: "FAILED", admit: (s) => s === "failed" },
  { key: "cancelled", label: "CANCELLED", admit: (s) => s === "cancelled" },
  { key: "unknown", label: "UNKNOWN", admit: (s) => s === "unknown" },
];

/**
 * Partition the (already filtered) runs into the fixed sections, dropping
 * any empty section so the view can map straight over the result.
 */
export function groupRuns(runs: RunSummary[]): RunGroup[] {
  const groups: RunGroup[] = [];
  for (const def of GROUP_ORDER) {
    const matched = runs.filter((run) => def.admit(run.status));
    if (matched.length === 0) continue;
    groups.push({ key: def.key, label: def.label, runs: matched });
  }
  return groups;
}

/** Headline counts for the header sub-line and the card sub (active/done/failed). */
export type RunsSummary = {
  total: number;
  active: number;
  done: number;
  failed: number;
  cancelled: number;
  unknown: number;
};

export function summarizeRuns(runs: RunSummary[]): RunsSummary {
  let active = 0;
  let done = 0;
  let failed = 0;
  let cancelled = 0;
  let unknown = 0;
  for (const run of runs) {
    if (run.status === "running" || run.status === "waiting") active += 1;
    else if (run.status === "finished") done += 1;
    else if (run.status === "failed") failed += 1;
    else if (run.status === "cancelled") cancelled += 1;
    else unknown += 1;
  }
  return { total: runs.length, active, done, failed, cancelled, unknown };
}

/** True for terminal runs — only terminal rows omit Rerun; the list shows
 *  Rerun on non-terminal runs per the spec. */
export function isTerminal(status: RunListStatus): boolean {
  return status === "finished" || status === "failed" || status === "cancelled";
}

/**
 * Whether a roster row belongs to a repo-scoped runs surface. Matching is
 * case-insensitive on owner/repo. A row with NO `repoContext` is
 * scope-UNKNOWN, not scopeless: the gateway bridge's rows are session-scoped
 * by design, so the scoped view keeps them visible exactly like the unscoped
 * roster always has — hiding them would invent a repo boundary the backend
 * never reported.
 */
export function matchesRepo(run: RunSummary, repo: { owner: string; repo: string }): boolean {
  const ctx = run.repoContext;
  if (!ctx) return true;
  return ctx.owner.toLowerCase() === repo.owner.toLowerCase() && ctx.repo.toLowerCase() === repo.repo.toLowerCase();
}

/**
 * The minimal runs embed's row selection: the top-`limit` runs with ACTIVE
 * (running/waiting) rows first in roster order, then settled runs in roster
 * order to fill — so the inline form always surfaces what is live right now,
 * and a settled row can still carry its verdict chip. Pure: roster order in,
 * selection out, no clock.
 */
export function runsEmbedTop(runs: RunSummary[], limit: number): RunSummary[] {
  const active = runs.filter((run) => run.status === "running" || run.status === "waiting");
  if (active.length >= limit) return active.slice(0, limit);
  const settled = runs.filter((run) => run.status !== "running" && run.status !== "waiting");
  return [...active, ...settled].slice(0, limit);
}
