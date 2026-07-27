import { useMemo } from "react";
import {
  DEFAULT_FILTERS,
  distinctWorkflows,
  filterRuns,
  groupRuns,
  hasActiveFilters as hasActiveFiltersOf,
  summarizeRuns,
  type RunFilters,
  type RunGroup,
  type RunSummary,
  type RunsSummary,
} from "./runsList.ts";
import { useRunsListStore } from "./runsListStore.ts";

/**
 * The runs LIST view model: filtered/grouped/summarized roster + the header
 * filter setters, read from `runsListStore` (populated by `RunsListBridge`,
 * which must be mounted once near the app root — mirrors multi's
 * `<RunsListBridge />` inside `<SyncProvider>`). packages/tui's RunsListMode
 * consumes this hook today (`research/tui-parity/03-tui-screens.md` "Runs
 * list"); multi's own `RunsCanvas`/`RunsListBridge` still read `runsList.ts`'s
 * reducers directly rather than through this hook (that canvas is mid-refactor
 * upstream in multi as of this phase — see the `runsList.ts`/`Run.ts`/
 * `statusMeta.ts` re-export note), so filter/group/summarize logic is shared
 * via those pure modules, not yet via one view-model hook on both platforms.
 */
export type RunsListVm = {
  /** The full merged roster (delegated ∪ backend), unfiltered. */
  allRuns: RunSummary[];
  /** The roster after every active filter is applied, in roster order. */
  filteredRuns: RunSummary[];
  /** `filteredRuns` partitioned into the four fixed sections. */
  groups: RunGroup[];
  /** Headline counts over `filteredRuns`. */
  summary: RunsSummary;
  /** Distinct workflow names in the roster, for a filter menu. */
  workflows: string[];
  filters: RunFilters;
  hasActiveFilters: boolean;
  /** True once a bridge has pushed a roster at least once. */
  rosterHydrated: boolean;
  setStatusFilter: (status: RunFilters["status"]) => void;
  setWorkflowFilter: (name: RunFilters["workflow"]) => void;
  setAgeFilter: (bucket: RunFilters["age"]) => void;
  setSearch: (value: string) => void;
  clearFilters: () => void;
};

export function useRunsListVm(): RunsListVm {
  const runs = useRunsListStore((s) => s.runs);
  const rosterHydrated = useRunsListStore((s) => s.rosterHydrated);
  const statusFilter = useRunsListStore((s) => s.statusFilter);
  const workflowFilter = useRunsListStore((s) => s.workflowFilter);
  const ageFilter = useRunsListStore((s) => s.ageFilter);
  const search = useRunsListStore((s) => s.search);
  const setStatusFilter = useRunsListStore((s) => s.setStatusFilter);
  const setWorkflowFilter = useRunsListStore((s) => s.setWorkflowFilter);
  const setAgeFilter = useRunsListStore((s) => s.setAgeFilter);
  const setSearch = useRunsListStore((s) => s.setSearch);
  const clearFilters = useRunsListStore((s) => s.clearFilters);

  const filters: RunFilters = useMemo(
    () => ({ status: statusFilter, workflow: workflowFilter, age: ageFilter, search }),
    [statusFilter, workflowFilter, ageFilter, search],
  );

  const filteredRuns = useMemo(() => filterRuns(runs, filters), [runs, filters]);
  const groups = useMemo(() => groupRuns(filteredRuns), [filteredRuns]);
  const summary = useMemo(() => summarizeRuns(filteredRuns), [filteredRuns]);
  const workflows = useMemo(() => distinctWorkflows(runs), [runs]);

  return {
    allRuns: runs,
    filteredRuns,
    groups,
    summary,
    workflows,
    filters,
    hasActiveFilters: hasActiveFiltersOf(filters),
    rosterHydrated,
    setStatusFilter,
    setWorkflowFilter,
    setAgeFilter,
    setSearch,
    clearFilters,
  };
}

export { DEFAULT_FILTERS };
