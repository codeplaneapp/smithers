/** @jsxImportSource react */
/**
 * Monitor shell controls, built on the shared smithers-orchestrator/ui
 * primitives (Button, Input, Select, RowButton). These are the pure view
 * pieces of the monitor's topbar filters, runs rail, pagination, and run
 * lifecycle actions. The small lifecycle controller owns only the cancel
 * confirmation state so rendered tests can exercise its wiring without
 * booting a gateway; RPC wiring stays in the panel modules (monitorApp,
 * monitorRuns, monitorRunDetail, ...).
 */
import { useEffect, useState, type ComponentProps, type ReactNode } from "react";
import {
  Button,
  Input,
  RowButton,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "smithers-orchestrator/ui";
import { cancelConfirmationTransition, type Tone } from "./monitorModel.ts";

export function ToneDot({ tone, pulse }: { tone: Tone; pulse?: boolean }) {
  return <span className={`mon-dot tone-${tone}${pulse ? " mon-dot-pulse" : ""}`} aria-hidden />;
}

export type ChipProps = ComponentProps<typeof Button> & {
  /** Toggle state: undefined = plain action chip (Close, Live, ◀ ▶). */
  on?: boolean;
};

/**
 * Small toggle/action button — the monitor's "chip" (Frames, XML, Timeline,
 * event views, Follow, Metrics, modal Close). A shared-UI Button in the small
 * size; toggles carry `aria-pressed` plus the `is-on` accent class.
 */
export function Chip({ on, className, ...props }: ChipProps) {
  return (
    <Button
      variant="outline"
      size="sm"
      aria-pressed={on === undefined ? undefined : on}
      className={`mon-toggle${on ? " is-on" : ""}${className ? ` ${className}` : ""}`}
      {...props}
    />
  );
}

/**
 * One topbar filter: a Radix Select over string options with a leading
 * "all …" row (the migrated native `<select className="mon-select">`).
 */
export function FilterSelect({
  value,
  onValueChange,
  options,
  allLabel,
  label,
  testId,
}: {
  value: string;
  onValueChange: (value: string) => void;
  options: string[];
  allLabel: string;
  label: string;
  testId: string;
}) {
  return (
    <Select value={value} onValueChange={onValueChange}>
      <SelectTrigger data-testid={testId} aria-label={label}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="all">{allLabel}</SelectItem>
        {options.map((option) => (
          <SelectItem key={option} value={option}>
            {option}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** The topbar's filter strip: search input, status/workflow selects, counts, Metrics toggle, Refresh. */
export function MonitorToolbar({
  filterText,
  onFilterText,
  statusFilter,
  onStatusFilter,
  statuses,
  workflowFilter,
  onWorkflowFilter,
  workflows,
  visibleCount,
  totalCount,
  showMetrics,
  onToggleMetrics,
  onRefresh,
}: {
  filterText: string;
  onFilterText: (text: string) => void;
  statusFilter: string;
  onStatusFilter: (status: string) => void;
  statuses: string[];
  workflowFilter: string;
  onWorkflowFilter: (workflow: string) => void;
  workflows: string[];
  visibleCount: number;
  totalCount: number;
  showMetrics: boolean;
  onToggleMetrics: () => void;
  onRefresh: () => void;
}) {
  return (
    <div className="mon-toolbar">
      <Input
        className="mon-filter-input"
        data-testid="monitor-filter"
        value={filterText}
        onChange={(event) => onFilterText(event.currentTarget.value)}
        placeholder="Search runs…"
        type="search"
      />
      <FilterSelect
        value={statusFilter}
        onValueChange={onStatusFilter}
        options={statuses}
        allLabel="all statuses"
        label="Filter by status"
        testId="monitor-status-filter"
      />
      <FilterSelect
        value={workflowFilter}
        onValueChange={onWorkflowFilter}
        options={workflows}
        allLabel="all workflows"
        label="Filter by workflow"
        testId="monitor-workflow-filter"
      />
      <span className="mon-dim mon-count-note">
        {visibleCount}/{totalCount} runs
      </span>
      <Chip
        on={showMetrics}
        data-testid="monitor-metrics-chip"
        onClick={onToggleMetrics}
        title="Operator stats from the gateway's Prometheus /metrics: agent latency percentiles, run/RPC/connection counters, error counters"
      >
        Metrics
      </Chip>
      <Button variant="outline" onClick={onRefresh}>
        Refresh
      </Button>
    </div>
  );
}

/** One selectable run row in the rail (the house RowButton run-row recipe). */
export function RunRailRow({
  runId,
  name,
  title,
  shortId,
  tone,
  pulse,
  when,
  active,
  onSelect,
}: {
  runId: string;
  name: string;
  title: string;
  shortId: string;
  tone: Tone;
  pulse: boolean;
  when: ReactNode;
  active: boolean;
  onSelect: (runId: string) => void;
}) {
  return (
    <RowButton
      active={active}
      className="mon-run-row"
      data-testid="monitor-run-row"
      data-run-id={runId}
      onClick={() => onSelect(runId)}
    >
      <ToneDot tone={tone} pulse={pulse} />
      <span className="mon-run-name" title={title}>
        {name}
      </span>
      <span className="mon-mono mon-dim">{shortId}</span>
      <span className="mon-run-when mon-dim">{when}</span>
    </RowButton>
  );
}

/** Landing runs-table pagination footer (client-side pages over the fetched window). */
export function RunsPagination({
  page,
  pageCount,
  firstRow,
  lastRow,
  total,
  onPageChange,
}: {
  page: number;
  pageCount: number;
  firstRow: number;
  lastRow: number;
  total: number;
  onPageChange: (page: number) => void;
}) {
  return (
    <footer className="mon-runs-pagination" data-testid="monitor-runs-pagination">
      <span className="mon-dim mon-count-note">
        Showing {firstRow}–{lastRow} of {total}
      </span>
      <span className="mon-runs-pagination-controls">
        <Button
          variant="outline"
          size="sm"
          data-testid="monitor-page-prev"
          disabled={page <= 1}
          onClick={() => onPageChange(page - 1)}
        >
          Prev
        </Button>
        <span className="mon-dim mon-count-note">
          Page {page} / {pageCount}
        </span>
        <Button
          variant="outline"
          size="sm"
          data-testid="monitor-page-next"
          disabled={page >= pageCount}
          onClick={() => onPageChange(page + 1)}
        >
          Next
        </Button>
      </span>
    </footer>
  );
}

export type RunLifecycleKind = "cancel" | "resume" | "pause";

export type RunLifecycleActionsProps = {
  resumable: boolean;
  pausable: boolean;
  cancellable: boolean;
  busyAction: RunLifecycleKind | null;
  cancelArmed?: boolean;
  onAction: (kind: RunLifecycleKind) => void;
  onCancelKeep?: () => void;
};

/** Resume / Pause / Cancel — the run detail header's lifecycle actions. */
export function RunLifecycleActions({
  resumable,
  pausable,
  cancellable,
  busyAction,
  cancelArmed = false,
  onAction,
  onCancelKeep,
}: RunLifecycleActionsProps) {
  return (
    <>
      {resumable ? (
        <Button
          variant="outline"
          data-testid="monitor-resume-run"
          disabled={busyAction !== null}
          onClick={() => onAction("resume")}
        >
          {busyAction === "resume" ? "Resuming…" : "Resume"}
        </Button>
      ) : null}
      {pausable ? (
        <Button
          variant="outline"
          data-testid="monitor-pause-run"
          disabled={busyAction !== null}
          title="Stop scheduling new tasks, let in-flight tasks finish, then park the run resumably"
          onClick={() => onAction("pause")}
        >
          {busyAction === "pause" ? "Pausing…" : "Pause"}
        </Button>
      ) : null}
      {cancellable ? (
        cancelArmed ? (
          <>
            <Button
              variant="destructive"
              data-testid="monitor-confirm-cancel-run"
              disabled={busyAction !== null}
              onClick={() => onAction("cancel")}
            >
              Confirm cancel?
            </Button>
            <Button variant="ghost" data-testid="monitor-keep-cancel-run" disabled={busyAction !== null} onClick={onCancelKeep}>
              Keep
            </Button>
          </>
        ) : (
          <Button
            variant="destructive"
            data-testid="monitor-cancel-run"
            disabled={busyAction !== null}
            onClick={() => onAction("cancel")}
          >
            Cancel
          </Button>
        )
      ) : null}
    </>
  );
}

/** Stateful cancel confirmation shared by RunDetail and rendered regression tests. */
export function RunLifecycleControls({
  runId,
  confirmationTimeoutMs = 4_000,
  now = Date.now,
  onAction,
  ...props
}: Omit<RunLifecycleActionsProps, "cancelArmed" | "onAction" | "onCancelKeep"> & {
  runId: string;
  confirmationTimeoutMs?: number;
  now?: () => number;
  onAction: (kind: RunLifecycleKind) => void;
}) {
  const [cancelArm, setCancelArm] = useState<{ runId: string; armedAtMs: number } | null>(null);
  const cancelArmed = cancelArm?.runId === runId;

  useEffect(() => {
    setCancelArm(null);
  }, [runId]);

  useEffect(() => {
    if (!cancelArmed || !cancelArm) return;
    const armedRunId = cancelArm.runId;
    const delay = Math.max(0, confirmationTimeoutMs - (now() - cancelArm.armedAtMs));
    const timer = setTimeout(() => {
      setCancelArm((current) => (current?.runId === armedRunId ? null : current));
    }, delay);
    return () => clearTimeout(timer);
  }, [cancelArm, cancelArmed, confirmationTimeoutMs, now]);

  const handleAction = (kind: RunLifecycleKind) => {
    if (kind !== "cancel") {
      onAction(kind);
      return;
    }
    const transition = cancelConfirmationTransition(
      { armedAtMs: cancelArmed && cancelArm ? cancelArm.armedAtMs : null },
      cancelArmed ? "confirm" : "arm",
      now(),
      confirmationTimeoutMs,
    );
    if (transition.decision === "confirmed") {
      setCancelArm(null);
      onAction("cancel");
      return;
    }
    setCancelArm(
      transition.state.armedAtMs === null ? null : { runId, armedAtMs: transition.state.armedAtMs },
    );
  };

  return (
    <RunLifecycleActions
      {...props}
      cancelArmed={cancelArmed}
      onAction={handleAction}
      onCancelKeep={() => setCancelArm(null)}
    />
  );
}
