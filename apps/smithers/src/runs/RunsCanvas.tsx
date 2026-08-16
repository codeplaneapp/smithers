import "./runsList.css";
import { useEffect, useRef, useState } from "react";
import { Alert, AlertDescription, Badge, EmptyState, Skeleton, StatusPill } from "@smthrs/ui";
import { openSurface } from "../app/navigation";
import { useUiStore } from "../app/uiStore";
import { MenuBackdrop } from "../components/MenuBackdrop";
import { CheckIcon } from "../icons/CheckIcon";
import { ChevronDownIcon } from "../icons/ChevronDownIcon";
import { SearchIcon } from "../icons/SearchIcon";
import {
  distinctWorkflows,
  filterRuns,
  groupRuns,
  hasActiveFilters,
  runDisplayName,
  runActionAvailability,
  runLifecycleStatus,
  runStatusLabel,
  runStatusToNode,
  shortRunId,
  shouldShowProgress,
  type AgeFilter,
  type RunStatusFilter,
  type RunSummary,
} from "./runsList";
import { useRunsListStore, type RunAction } from "./runsListStore";

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
  const workflowKey = run.workflowKey && run.workflowKey.trim() !== "" ? run.workflowKey : run.runId;
  openSurface({ kind: "gatewayRun", workflowKey, runId: run.runId });
}

/** A run row's per-row quick actions + the inline approval / error affordances. */
function RunRow({ run }: { run: RunSummary }) {
  const selectedRunId = useRunsListStore((state) => state.selectedRunId);
  const selectRun = useRunsListStore((state) => state.selectRun);
  const actingRunId = useRunsListStore((state) => state.actingRunId);
  const actingAction = useRunsListStore((state) => state.actingAction);
  const actionFeedback = useRunsListStore((state) => state.actionFeedback);
  const connectionStatus = useRunsListStore((state) => state.connectionStatus);
  const rpcReady = useRunsListStore((state) => state.rpc !== null);
  const performAction = useRunsListStore((state) => state.performAction);
  const [confirming, setConfirming] = useState<"cancel" | "retry" | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const retryRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const feedbackRef = useRef<HTMLDivElement>(null);
  const restoreFocus = useRef<"cancel" | "retry" | null>(null);

  const showProgress = shouldShowProgress(run);
  const pct = Math.round(run.progress * 100);
  const selected = selectedRunId === run.runId;
  const availability = runActionAvailability(run);
  const busy = actingRunId === run.runId;
  const actionsDisabled = actingRunId !== null || connectionStatus !== "online" || !rpcReady;
  const feedback = actionFeedback?.runId === run.runId ? actionFeedback : null;

  useEffect(() => {
    if (confirming) {
      confirmRef.current?.focus();
      return;
    }
    const action = restoreFocus.current;
    restoreFocus.current = null;
    if (action === "cancel") cancelRef.current?.focus();
    if (action === "retry") retryRef.current?.focus();
  }, [confirming]);

  useEffect(() => {
    if (feedback) feedbackRef.current?.focus();
  }, [feedback]);

  const cancelConfirmation = () => {
    restoreFocus.current = confirming;
    setConfirming(null);
  };

  const act = (action: RunAction) => {
    setConfirming(null);
    performAction(run.runId, action);
  };

  return (
    <div
      className={selected ? "runs-row is-on" : "runs-row"}
      data-testid="runs-row"
      data-run-id={run.runId}
      onClick={() => {
        selectRun(run.runId);
        openRunInspector(run);
      }}
    >
      <StatusPill status={runStatusToNode(runLifecycleStatus(run))} label={runStatusLabel(runLifecycleStatus(run))} />

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
        <Alert variant="destructive" className="runs-error">
          <AlertDescription>{run.errorText}</AlertDescription>
        </Alert>
      ) : null}

      {run.status === "waiting" && run.blockedNodeLabel ? (
        <Alert
          variant="warning"
          className="runs-approval"
          data-testid="runs-approval"
          onClick={(event) => event.stopPropagation()}
        >
          <AlertDescription>
            Waiting for approval: <span className="runs-approval-node">{run.blockedNodeLabel}</span>
          </AlertDescription>
          <div className="runs-approval-actions">
            <button className="btn btn-brand" type="button" onClick={() => openSurface({ kind: "approvals" })}>
              Review approval
            </button>
          </div>
        </Alert>
      ) : null}

      <div className="runs-row-actions" onClick={(event) => event.stopPropagation()}>
        <button className="btn" type="button" onClick={() => openRunInspector(run)}>
          Inspect
        </button>
        <button
          className="btn"
          type="button"
          onClick={() => {
            const workflowKey = run.workflowKey && run.workflowKey.trim() !== "" ? run.workflowKey : run.runId;
            openSurface({ kind: "gatewayRun", workflowKey, runId: run.runId, view: "logs" });
          }}
        >
          Logs
        </button>
        <button
          className="btn"
          type="button"
          onClick={() => {
            const workflowKey = run.workflowKey && run.workflowKey.trim() !== "" ? run.workflowKey : run.runId;
            openSurface({ kind: "gatewayRun", workflowKey, runId: run.runId, view: "timeline" });
          }}
        >
          Timeline
        </button>
        {availability.pause ? (
          <button
            className="btn"
            type="button"
            data-testid="runs-pause"
            aria-label={`Pause run ${run.runId}`}
            disabled={actionsDisabled}
            onClick={() => act("pause")}
          >
            {busy && actingAction === "pause" ? "Pausing…" : "Pause"}
          </button>
        ) : null}
        {availability.resume ? (
          <button
            className="btn run-resume"
            type="button"
            data-testid="runs-resume"
            aria-label={`Resume run ${run.runId}`}
            disabled={actionsDisabled}
            onClick={() => act("resume")}
          >
            {busy && actingAction === "resume" ? "Resuming…" : "Resume"}
          </button>
        ) : null}
        {availability.retry ? (
          <button
            ref={retryRef}
            className="btn"
            type="button"
            data-testid="runs-retry"
            aria-label={`Retry failed run ${run.runId}`}
            disabled={actionsDisabled}
            onClick={() => setConfirming("retry")}
          >
            Retry
          </button>
        ) : null}
        {availability.cancel ? (
          <button
            ref={cancelRef}
            className="btn btn-deny"
            type="button"
            data-testid="runs-cancel"
            aria-label={`Cancel run ${run.runId}`}
            disabled={actionsDisabled}
            onClick={() => setConfirming("cancel")}
          >
            Cancel
          </button>
        ) : null}
        <button
          className="btn"
          type="button"
          data-testid="runs-health"
          aria-label={`Check health of run ${run.runId}`}
          disabled={actionsDisabled}
          onClick={() => act("health")}
        >
          {busy && actingAction === "health" ? "Checking…" : "Check health"}
        </button>
      </div>

      {confirming ? (
        <div
          className="runs-action-confirm"
          role="alertdialog"
          aria-label={`${confirming === "cancel" ? "Cancel" : "Retry"} run ${run.runId}?`}
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            event.stopPropagation();
            cancelConfirmation();
          }}
        >
          <span>
            {confirming === "cancel"
              ? "Cancel this run? In-flight work may be interrupted."
              : "Launch a new run with the same workflow input?"}
          </span>
          <button
            ref={confirmRef}
            className="btn btn-deny"
            type="button"
            data-testid={`runs-confirm-${confirming}`}
            disabled={actionsDisabled}
            onClick={() => act(confirming)}
          >
            Confirm {confirming}
          </button>
          <button
            className="btn"
            type="button"
            aria-label={`Keep run ${run.runId}`}
            disabled={actionsDisabled}
            onClick={cancelConfirmation}
          >
            Keep run
          </button>
        </div>
      ) : null}

      {feedback ? (
        <div
          ref={feedbackRef}
          className={`runs-action-feedback is-${feedback.kind}`}
          role={feedback.kind === "error" ? "alert" : "status"}
          tabIndex={-1}
          onClick={(event) => event.stopPropagation()}
        >
          {feedback.message}
        </div>
      ) : null}
    </div>
  );
}

/** The full runs LIST surface: filters + grouped, searchable run roster. */
export function RunsCanvas() {
  const runs = useRunsListStore((state) => state.runs);
  const loading = useRunsListStore((state) => state.loading);
  const error = useRunsListStore((state) => state.error);
  const connectionStatus = useRunsListStore((state) => state.connectionStatus);
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

  const visibleRuns = connectionStatus === "unauthorized" ? [] : runs;
  const filters = { status: statusFilter, workflow: workflowFilter, age: ageFilter, search };
  const shown = filterRuns(visibleRuns, filters);
  const groups = groupRuns(shown);
  const workflows = distinctWorkflows(visibleRuns);
  const workflowOptions = [
    { id: "all", label: "All workflows" },
    ...workflows.map((name) => ({ id: name, label: name })),
  ];
  const showClear = hasActiveFilters(filters);
  const lastKnown = visibleRuns.length > 0 && (connectionStatus === "offline" || Boolean(error));
  const live = connectionStatus === "online" && streamMode === "live" && !error;
  const streamLabel = lastKnown
    ? "Last-known"
    : connectionStatus === "unauthorized"
      ? "Unauthorized"
      : connectionStatus === "offline"
        ? "Offline"
        : error
          ? "Unavailable"
          : connectionStatus === "idle" || connectionStatus === "connecting"
            ? "Connecting"
            : live
              ? "Live"
              : "Polling";
  const freshnessMessage = !lastKnown
    ? null
    : connectionStatus === "offline"
      ? "Gateway offline. Every run shown below is last-known data and may be out of date."
      : error
        ? `Refresh failed. Every run shown below is last-known data and may be out of date. ${error}`
        : null;

  return (
    <section className="surface" data-testid="runs-canvas">
      <header className="surface-head">
        <span className="surface-title">Runs</span>
        <Badge asChild variant={live ? "success" : "muted"}>
          <button
            type="button"
            className="runs-stream-badge"
            onClick={() => setStreamMode(live ? "polling" : "live")}
            data-live={live ? "true" : undefined}
            data-status={connectionStatus}
            data-testid="runs-stream-badge"
          >
            <span aria-hidden className="sui-status-dot" />
            {streamLabel}
          </button>
        </Badge>
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
          <FilterMenu menuId="runs-age" label="Time" value={ageFilter} options={AGE_OPTIONS} onSelect={setAgeFilter} />

          {showClear ? (
            <button className="runs-clear" type="button" onClick={clearFilters} data-testid="runs-clear">
              Clear
            </button>
          ) : null}
        </div>
      </header>

      <div className="runs-scroll">
        {freshnessMessage ? (
          <Alert
            variant="warning"
            className="runs-freshness"
            data-testid="runs-last-known"
            role={connectionStatus === "unauthorized" ? "alert" : "status"}
          >
            <AlertDescription>{freshnessMessage}</AlertDescription>
          </Alert>
        ) : null}

        {connectionStatus === "unauthorized" ? (
          <EmptyState
            className="surface-empty"
            data-testid="runs-landing-state"
            data-state="unauthorized"
            title="Authorization required"
            description="The gateway rejected these credentials. Sign in again or check workspace permissions."
            role="alert"
          />
        ) : connectionStatus === "offline" && runs.length === 0 ? (
          <EmptyState
            className="surface-empty"
            data-testid="runs-landing-state"
            data-state="offline-without-cache"
            title="Gateway offline"
            description="No last-known run data is available. Reconnecting automatically."
            role="alert"
          />
        ) : loading && runs.length === 0 ? (
          <div className="surface-empty" role="status" data-testid="runs-loading">
            <Skeleton style={{ width: "min(480px, 80%)", height: 48 }} />
            <span className="runs-loading-message">
              {connectionStatus === "idle" || connectionStatus === "connecting"
                ? "Connecting to the gateway…"
                : "Loading runs…"}
            </span>
          </div>
        ) : error && runs.length === 0 ? (
          <EmptyState
            className="surface-empty"
            data-testid="runs-landing-state"
            data-state="error"
            title="Runs unavailable"
            description={error}
            role="alert"
          />
        ) : groups.length > 0 ? (
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
          <EmptyState
            className="surface-empty"
            data-testid="runs-landing-state"
            data-state={showClear ? "filtered" : "empty"}
            title={showClear ? "No runs match your filters." : "No runs yet."}
          />
        )}
      </div>
    </section>
  );
}
