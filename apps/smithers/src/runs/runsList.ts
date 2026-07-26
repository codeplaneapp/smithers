/**
 * The runs LIST surface: a filterable, grouped roster of workflow runs ported
 * from the Swift RunsView. Each `RunSummary` carries the status pill, progress,
 * and elapsed-badge fields the card and canvas render.
 *
 * The roster is sourced LIVE from the gateway `runs` collection via
 * `RunsListBridge` (`useGatewayRuns()`), NOT from any in-app seed. This module
 * holds only the pure types + filter/group/summarize reducers, unit-tested
 * without a DOM against inline fixtures (see runsListDomain.test.ts).
 */
import type { NodeStatus } from "./Run";
import type { StatusTone } from "./statusMeta";

/** A run's lifecycle as the list models it (a superset of NodeStatus framing). */
export type RunListStatus = "running" | "waiting" | "finished" | "failed" | "cancelled";

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

/** One run in the roster, fully seeded — no derived-at-render timing. */
export type RunSummary = {
  id: string;
  /** 8-char hex, deterministic via FNV-1a shortHash of the title. */
  runId: string;
  workflowName: string;
  /**
   * The gateway workflow key the row belongs to, preserved from the live
   * `runs` collection so a list row can route to the gateway run inspector
   * (`/gw/$workflowKey/$runId`). Absent on locally-seeded rows; falls back to a
   * resolvable placeholder when the live row carries no key (see RunsCanvas).
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
      return "queued";
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
  return name === "" ? "Unnamed workflow" : name;
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
export type RunGroupKey = "active" | "completed" | "failed" | "cancelled";

export type RunGroup = { key: RunGroupKey; label: string; runs: RunSummary[] };

const GROUP_ORDER: { key: RunGroupKey; label: string; admit: (s: RunListStatus) => boolean }[] = [
  { key: "active", label: "ACTIVE", admit: (s) => s === "running" || s === "waiting" },
  { key: "completed", label: "COMPLETED", admit: (s) => s === "finished" },
  { key: "failed", label: "FAILED", admit: (s) => s === "failed" },
  { key: "cancelled", label: "CANCELLED", admit: (s) => s === "cancelled" },
];

/**
 * Partition the (already filtered) runs into the four fixed sections, dropping
 * any empty section so the canvas can map straight over the result.
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
};

export function summarizeRuns(runs: RunSummary[]): RunsSummary {
  let active = 0;
  let done = 0;
  let failed = 0;
  let cancelled = 0;
  for (const run of runs) {
    if (run.status === "running" || run.status === "waiting") active += 1;
    else if (run.status === "finished") done += 1;
    else if (run.status === "failed") failed += 1;
    else cancelled += 1;
  }
  return { total: runs.length, active, done, failed, cancelled };
}

/** True for terminal runs — RunsView hides Rerun for active runs (they re-run
 *  by resuming, not restarting), so only terminal rows omit it. The list shows
 *  Rerun on non-terminal runs per the spec. */
export function isTerminal(status: RunListStatus): boolean {
  return status === "finished" || status === "failed" || status === "cancelled";
}
