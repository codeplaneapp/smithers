import { create } from "zustand";
import {
  DEFAULT_FILTERS,
  type AgeFilter,
  type RunListStatus,
  type RunStatusFilter,
  type RunSummary,
  type RunVerdict,
} from "./runsList.ts";

/**
 * The runs-list store: the live run roster plus header filters and search.
 * Ported from multi's `src/runs/runsListStore.ts`, with one deliberate trim:
 * multi's version also pushes browser-only observability gauges
 * (`../observability/uiMetrics`, `./workerCapacity`) on every roster write.
 * That wiring is product telemetry, not roster domain logic, so it stays in
 * multi — its own bridge subscribes to this store and updates its gauges from
 * `runs` changes instead of this module reaching into a browser-only exporter.
 *
 * The roster merges TWO sources:
 * - `backendRuns` — what a bridge pushes via `setRunsListRows`: the gateway
 *   `runs` collection, the canonical history.
 * - `delegatedRuns` — runs launched THIS SESSION (e.g. from a concierge chat
 *   flow), upserted at launch and status-updated from the run-event stream.
 *   Session-scoped, NOT repo-scoped: the gateway run is real regardless of
 *   which repo mirror is open. After a full reload only backend-persisted
 *   runs remain.
 *
 * The public `runs` is the merge — delegated rows newest-first ahead of the
 * backend roster, deduped on runId with the BACKEND row winning once it
 * appears (it carries real timestamps), so a live collection that already
 * lists the launch never shows doubles.
 */

type RunsListState = {
  /** The MERGED roster the surfaces render: delegatedRuns ∪ backendRuns. */
  runs: RunSummary[];
  /** The bridge-pushed backend roster (the gateway `runs` collection). */
  backendRuns: RunSummary[];
  /** Session-scoped rows for runs delegated this session, newest first. */
  delegatedRuns: RunSummary[];
  /**
   * True once a bridge has pushed a roster (even an empty one). Readers that
   * summarize the roster use this to show an honest "live run data
   * unavailable" state instead of a fabricated zero before the first push.
   */
  rosterHydrated: boolean;
  statusFilter: RunStatusFilter;
  workflowFilter: string | "all";
  ageFilter: AgeFilter;
  search: string;
  setStatusFilter: (status: RunStatusFilter) => void;
  setWorkflowFilter: (name: string | "all") => void;
  setAgeFilter: (bucket: AgeFilter) => void;
  setSearch: (value: string) => void;
  clearFilters: () => void;
};

/**
 * Principal epoch for detached launch/resume continuations. A definitive
 * identity reset advances it before clearing the roster, so a response sent
 * under account A cannot repopulate or emit actions under account B.
 */
let runsIdentityEpoch = 0;

export function captureRunsIdentityEpoch(): number {
  return runsIdentityEpoch;
}

export function isRunsIdentityEpochCurrent(epoch: number): boolean {
  return epoch === runsIdentityEpoch;
}

/**
 * Merge the two sources into the rendered roster: delegated rows (already
 * newest-first) ahead of the backend roster, deduped on runId. The backend row
 * wins once it appears — it carries the run's real timestamps/status — so the
 * delegated row hands off seamlessly instead of doubling.
 */
function mergeRunMetadata(backend: RunSummary, delegated: RunSummary | undefined): RunSummary {
  if (!delegated) return backend;
  const patch: Partial<RunSummary> = {};
  if (!backend.inferencePool && delegated.inferencePool) patch.inferencePool = delegated.inferencePool;
  if (!backend.completion && delegated.completion) patch.completion = delegated.completion;
  if (!backend.repoContext && delegated.repoContext) patch.repoContext = delegated.repoContext;
  if (!backend.sourceBookmark && delegated.sourceBookmark) patch.sourceBookmark = delegated.sourceBookmark;
  if (!backend.targetBookmark && delegated.targetBookmark) patch.targetBookmark = delegated.targetBookmark;
  if (!backend.launchInputs && delegated.launchInputs) patch.launchInputs = delegated.launchInputs;
  if (Object.keys(patch).length === 0) return backend;
  return {
    ...backend,
    ...patch,
  };
}

function mergeRuns(delegatedRuns: RunSummary[], backendRuns: RunSummary[]): RunSummary[] {
  if (delegatedRuns.length === 0) return backendRuns;
  const delegatedById = new Map(delegatedRuns.map((run) => [run.runId, run]));
  const backendIds = new Set(backendRuns.map((run) => run.runId));
  return [
    ...delegatedRuns.filter((run) => !backendIds.has(run.runId)),
    ...backendRuns.map((run) => mergeRunMetadata(run, delegatedById.get(run.runId))),
  ];
}

function patchRun(runs: RunSummary[], runId: string, patch: Partial<RunSummary>): RunSummary[] {
  return runs.map((run) => (run.runId === runId ? { ...run, ...patch } : run));
}

export const useRunsListStore = create<RunsListState>((set) => ({
  // Sourced live from the backend via a bridge + session launches; starts
  // empty until the first push.
  runs: [],
  backendRuns: [],
  delegatedRuns: [],
  rosterHydrated: false,
  statusFilter: DEFAULT_FILTERS.status,
  workflowFilter: DEFAULT_FILTERS.workflow,
  ageFilter: DEFAULT_FILTERS.age,
  search: DEFAULT_FILTERS.search,

  setStatusFilter: (status) => set({ statusFilter: status }),

  setWorkflowFilter: (name) => set({ workflowFilter: name }),

  setAgeFilter: (bucket) => set({ ageFilter: bucket }),

  setSearch: (value) => set({ search: value }),

  clearFilters: () =>
    set({
      statusFilter: DEFAULT_FILTERS.status,
      workflowFilter: DEFAULT_FILTERS.workflow,
      ageFilter: DEFAULT_FILTERS.age,
      search: DEFAULT_FILTERS.search,
    }),
}));

/**
 * Push the BACKEND roster (bridge poll/stream result). Recomputes the merged
 * `runs` (delegated session launches survive — a repo switch or an empty poll
 * clears only the backend rows).
 */
export function setRunsListRows(runs: RunSummary[], identityEpoch?: number): void {
  if (identityEpoch !== undefined && !isRunsIdentityEpochCurrent(identityEpoch)) return;
  useRunsListStore.setState((state) => {
    return {
      backendRuns: runs,
      runs: mergeRuns(state.delegatedRuns, runs),
      rosterHydrated: true,
    };
  });
}

/**
 * Clear both backend and session-delegated rows for a new principal. Unlike a
 * repo switch, an account switch must also drop delegated launch inputs and
 * repo context because those fields power follow-up and PR actions.
 */
export function resetRunsForIdentityChange(): void {
  runsIdentityEpoch += 1;
  useRunsListStore.setState({
    runs: [],
    backendRuns: [],
    delegatedRuns: [],
    rosterHydrated: false,
    statusFilter: DEFAULT_FILTERS.status,
    workflowFilter: DEFAULT_FILTERS.workflow,
    ageFilter: DEFAULT_FILTERS.age,
    search: DEFAULT_FILTERS.search,
  });
}

/**
 * Record a run delegated THIS SESSION (called the moment the gateway returns
 * a real runId — a failed launch has no runId and adds no row). Newest first;
 * an existing row with the same runId is replaced in place.
 */
export function upsertDelegatedRun(run: RunSummary, identityEpoch?: number): void {
  if (identityEpoch !== undefined && !isRunsIdentityEpochCurrent(identityEpoch)) return;
  useRunsListStore.setState((state) => {
    const exists = state.delegatedRuns.some((r) => r.runId === run.runId);
    const delegatedRuns = exists
      ? state.delegatedRuns.map((r) => (r.runId === run.runId ? run : r))
      : [run, ...state.delegatedRuns];
    return { delegatedRuns, runs: mergeRuns(delegatedRuns, state.backendRuns) };
  });
}

/**
 * Track a delegated run's LIVE status from the run-event stream a launch
 * dispatcher already consumes for its own notification. Unknown runId (or an
 * unchanged status) is a no-op — the stream never invents rows, and a stream
 * error leaves the last-known status in place (honest: never flip to finished).
 */
export function updateDelegatedRunStatus(runId: string, status: RunListStatus, identityEpoch?: number): void {
  if (identityEpoch !== undefined && !isRunsIdentityEpochCurrent(identityEpoch)) return;
  useRunsListStore.setState((state) => {
    const current = state.delegatedRuns.find((r) => r.runId === runId);
    if (!current || current.status === status) return state;
    const delegatedRuns = state.delegatedRuns.map((r) => (r.runId === runId ? { ...r, status } : r));
    return { delegatedRuns, runs: mergeRuns(delegatedRuns, state.backendRuns) };
  });
}

/** Attach the strict verifier verdict to a settled run without inventing one. */
export function updateRunCompletion(runId: string, completion: RunVerdict, identityEpoch?: number): void {
  if (identityEpoch !== undefined && !isRunsIdentityEpochCurrent(identityEpoch)) return;
  useRunsListStore.setState((state) => {
    const delegatedRuns = patchRun(state.delegatedRuns, runId, { completion });
    const backendRuns = patchRun(state.backendRuns, runId, { completion });
    return {
      delegatedRuns,
      backendRuns,
      runs: mergeRuns(delegatedRuns, backendRuns),
    };
  });
}

/**
 * Clear a stale roster without claiming that an empty backend result arrived.
 * A subsequent successful push — including a genuinely empty array — flips
 * `rosterHydrated` back to true through `setRunsListRows`. Clears the backend
 * roster (the delegated session rows survive) and re-merges.
 */
export function setRunsListUnavailable(identityEpoch?: number): void {
  if (identityEpoch !== undefined && !isRunsIdentityEpochCurrent(identityEpoch)) return;
  useRunsListStore.setState((state) => ({
    backendRuns: [],
    runs: mergeRuns(state.delegatedRuns, []),
    rosterHydrated: false,
  }));
}
