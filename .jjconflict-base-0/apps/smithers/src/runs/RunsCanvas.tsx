import "./runsList.css";
import { openSurface } from "../app/navigation";
import { useUiStore } from "../app/uiStore";
import { StatusPill } from "../cards/StatusPill";
import { MenuBackdrop } from "../components/MenuBackdrop";
import { CheckIcon } from "../icons/CheckIcon";
import { ChevronDownIcon } from "../icons/ChevronDownIcon";
import { SearchIcon } from "../icons/SearchIcon";
import {
  distinctWorkflows,
  filterRuns,
  groupRuns,
  hasActiveFilters,
  isTerminal,
  runDisplayName,
  runStatusToNode,
  shortRunId,
  shouldShowProgress,
  type AgeFilter,
  type RunStatusFilter,
  type RunSummary,
} from "./runsList";
import { useRunsListStore } from "./runsListStore";

/** The status filter values, mirroring RunsView's status Menu. */
const STATUS_OPTIONS: { id: RunStatusFilter; label: string }[] = [
  { id: "all", label: "All statuses" },
  { id: "running", label: "Running" },
  { id: "waiting", label: "Waiting" },
  { id: "finished", label: "Finished" },
  { id: "failed", label: "Failed" },
  { id: "cancelled", label: "Cancelled" },
];

/** The four date-window options, matched by seeded ageBucket inclusion. */
const AGE_OPTIONS: { id: AgeFilter; label: string }[] = [
  { id: "all", label: "All time" },
  { id: "today", label: "Today" },
  { id: "week", label: "This week" },
  { id: "month", label: "This month" },
];

/**
 * A compact filter dropdown: a trigger showing the current value that opens a
 * downward radio menu. Replaces the old wall of segmented pills — three of these
 * (status, workflow, time) read far calmer than ~18 chips. Open state lives in
 * the shared `useUiStore` menu slot, so only one filter menu is open at a time.
 * Generic over the option id so each call stays type-safe with its own setter.
 */
function FilterMenu<T extends string>({
  menuId,
  label,
  value,
  options,
  onSelect,
}: {
  menuId: string;
  label: string;
  value: T;
  options: { id: T; label: string }[];
  onSelect: (id: T) => void;
}) {
  const open = useUiStore((state) => state.openMenuId === menuId);
  const toggleMenu = useUiStore((state) => state.toggleMenu);
  const setOpenMenu = useUiStore((state) => state.setOpenMenu);
  const current = options.find((option) => option.id === value) ?? options[0];

  return (
    <div className="runs-filter">
      <button
        type="button"
        className="runs-filter-trigger"
        data-active={value !== "all"}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${label}: ${current.label}`}
        onClick={() => toggleMenu(menuId)}
      >
        <span className="runs-filter-value">{current.label}</span>
        <ChevronDownIcon />
      </button>
      {open ? (
        <>
          <MenuBackdrop />
          <div className="runs-menu" role="menu" aria-label={label}>
            {options.map((option) => (
              <button
                key={option.id}
                type="button"
                role="menuitemradio"
                aria-checked={option.id === value}
                className="runs-menu-item"
                onClick={() => {
                  onSelect(option.id);
                  setOpenMenu(null);
                }}
              >
                <span>{option.label}</span>
                {option.id === value ? <CheckIcon /> : null}
              </button>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}

/**
 * Open a list row in the GATEWAY run inspector (`/gw/$workflowKey/$runId`).
 *
 * The list is sourced from the live gateway `runs` collection (`RunsListBridge`),
 * NOT the local engine `runsStore`, so the local `/runs/$runId` inspector — which
 * reads `runsStore` — would render "Run not found." for these real rows. Route
 * gateway-sourced rows to the gateway inspector, which subscribes to the real run
 * tree. The route needs a workflow key; live rows preserve it via
 * `toRunSummary`. When a row genuinely lacks one, fall back to the runId as the
 * path segment — the gateway inspector resolves the run from `runId` (the
 * workflow key only selects the optional custom Workflow UI, which simply won't
 * render for the fallback), so the row still lands on a WORKING inspector for the
 * real run rather than the dead local route.
 */
function openRunInspector(run: RunSummary): void {
  const workflowKey =
    run.workflowKey && run.workflowKey.trim() !== "" ? run.workflowKey : run.runId;
  openSurface({ kind: "gatewayRun", workflowKey, runId: run.runId });
}

/** A run row's per-row quick actions + the inline approval / error affordances. */
function RunRow({ run }: { run: RunSummary }) {
  const selectedRunId = useRunsListStore((state) => state.selectedRunId);
  const selectRun = useRunsListStore((state) => state.selectRun);
  const rerun = useRunsListStore((state) => state.rerun);
  const resume = useRunsListStore((state) => state.resume);
  const approve = useRunsListStore((state) => state.approve);
  const deny = useRunsListStore((state) => state.deny);

  const terminal = isTerminal(run.status);
  const showProgress = shouldShowProgress(run);
  const pct = Math.round(run.progress * 100);
  const selected = selectedRunId === run.runId;

  return (
    <div
      className={selected ? "runs-row is-on" : "runs-row"}
      data-testid="runs-row"
      onClick={() => {
        selectRun(run.runId);
        openRunInspector(run);
      }}
    >
      <StatusPill status={runStatusToNode(run.status)} label={run.status} />

      <div className="runs-row-text">
        <div className="runs-row-name">{runDisplayName(run)}</div>
        <div className="runs-row-id">{shortRunId(run.runId)}</div>
      </div>

      <div className="runs-row-right">
        <span className="runs-row-elapsed">{run.elapsedLabel}</span>
      </div>

      {showProgress ? (
        <div className="runs-row-progress">
          <div className="runs-progress-bar">
            <div className="runs-progress-fill" style={{ width: `${pct}%` }} />
          </div>
          <span className="runs-progress-pct">{pct}%</span>
        </div>
      ) : null}

      {run.status === "failed" && run.errorText ? (
        <div className="runs-error">{run.errorText}</div>
      ) : null}

      {run.status === "waiting" && run.blockedNodeLabel ? (
        <div
          className="runs-approval"
          data-testid="runs-approval"
          onClick={(event) => event.stopPropagation()}
        >
          <span>
            Waiting for approval:{" "}
            <span className="runs-approval-node">{run.blockedNodeLabel}</span>
          </span>
          <div className="runs-approval-actions">
            <button
              className="btn btn-brand tone-ok"
              type="button"
              onClick={() => approve(run.runId)}
            >
              Approve
            </button>
            <button className="btn btn-deny" type="button" onClick={() => deny(run.runId)}>
              Deny
            </button>
          </div>
        </div>
      ) : null}

      <div className="runs-row-actions" onClick={(event) => event.stopPropagation()}>
        <button
          className="btn"
          type="button"
          onClick={() => openRunInspector(run)}
        >
          Inspect
        </button>
        <button
          className="btn"
          type="button"
          onClick={() => {
            const workflowKey =
              run.workflowKey && run.workflowKey.trim() !== "" ? run.workflowKey : run.runId;
            openSurface({ kind: "gatewayRun", workflowKey, runId: run.runId, view: "logs" });
          }}
        >
          Logs
        </button>
        <button
          className="btn"
          type="button"
          onClick={() => {
            const workflowKey =
              run.workflowKey && run.workflowKey.trim() !== "" ? run.workflowKey : run.runId;
            openSurface({ kind: "gatewayRun", workflowKey, runId: run.runId, view: "timeline" });
          }}
        >
          Timeline
        </button>
        {!terminal ? (
          <button className="btn" type="button" onClick={() => rerun(run.runId)}>
            Rerun
          </button>
        ) : null}
        {run.status === "failed" || run.status === "cancelled" ? (
          <button className="btn run-resume" type="button" onClick={() => resume(run.runId)}>
            Resume
          </button>
        ) : null}
      </div>
    </div>
  );
}

/** The full runs LIST surface: filters + grouped, searchable run roster. */
export function RunsCanvas() {
  const runs = useRunsListStore((state) => state.runs);
  const statusFilter = useRunsListStore((state) => state.statusFilter);
  const workflowFilter = useRunsListStore((state) => state.workflowFilter);
  const ageFilter = useRunsListStore((state) => state.ageFilter);
  const search = useRunsListStore((state) => state.search);
  const streamMode = useRunsListStore((state) => state.streamMode);
  const setStatusFilter = useRunsListStore((state) => state.setStatusFilter);
  const setWorkflowFilter = useRunsListStore((state) => state.setWorkflowFilter);
  const setAgeFilter = useRunsListStore((state) => state.setAgeFilter);
  const setSearch = useRunsListStore((state) => state.setSearch);
  const setStreamMode = useRunsListStore((state) => state.setStreamMode);
  const clearFilters = useRunsListStore((state) => state.clearFilters);

  const filters = { status: statusFilter, workflow: workflowFilter, age: ageFilter, search };
  const shown = filterRuns(runs, filters);
  const groups = groupRuns(shown);
  const workflows = distinctWorkflows(runs);
  const workflowOptions = [
    { id: "all", label: "All workflows" },
    ...workflows.map((name) => ({ id: name, label: name })),
  ];
  const showClear = hasActiveFilters(filters);
  const live = streamMode === "live";

  return (
    <section className="surface" data-testid="runs-canvas">
      <header className="surface-head">
        <span className="surface-title">Runs</span>
        <button
          type="button"
          className={`runs-stream-badge ${live ? "is-live" : "is-poll"}`}
          onClick={() => setStreamMode(live ? "polling" : "live")}
          data-testid="runs-stream-badge"
        >
          {live ? "Live" : "Polling"}
        </button>
        <span className="surface-sub">
          {shown.length} run{shown.length === 1 ? "" : "s"}
        </span>

        <div className="runs-toolbar" data-testid="runs-toolbar">
          <div className="runs-search-wrap">
            <SearchIcon />
            <input
              className="runs-search"
              placeholder="Search runs…"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              data-testid="runs-search"
            />
          </div>

          <FilterMenu
            menuId="runs-status"
            label="Status"
            value={statusFilter}
            options={STATUS_OPTIONS}
            onSelect={setStatusFilter}
          />
          <FilterMenu
            menuId="runs-workflow"
            label="Workflow"
            value={workflowFilter}
            options={workflowOptions}
            onSelect={setWorkflowFilter}
          />
          <FilterMenu
            menuId="runs-age"
            label="Time"
            value={ageFilter}
            options={AGE_OPTIONS}
            onSelect={setAgeFilter}
          />

          {showClear ? (
            <button className="runs-clear" type="button" onClick={clearFilters} data-testid="runs-clear">
              Clear
            </button>
          ) : null}
        </div>
      </header>

      <div className="runs-scroll">
        {groups.length > 0 ? (
          groups.map((group) => (
            <div className="runs-group" key={group.key} data-testid="runs-group">
              <div className="runs-group-head">
                {group.label} <span className="vcs-count">{group.runs.length}</span>
              </div>
              {group.runs.map((run) => (
                <RunRow key={run.runId} run={run} />
              ))}
            </div>
          ))
        ) : (
          <div className="surface-empty">No runs found.</div>
        )}
      </div>
    </section>
  );
}
