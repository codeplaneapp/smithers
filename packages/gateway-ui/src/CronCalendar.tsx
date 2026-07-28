/** @jsxImportSource react */
import { useInsertionEffect, useMemo, useState, type CSSProperties } from "react";
import {
  parseCronPattern,
  useCronSchedule,
  useGatewayActions,
  type CronScheduleEvent,
} from "@smithers-orchestrator/gateway-react";
import { Calendar, DAY_MS, startOfDay, type CalendarView } from "@smithers-orchestrator/ui/calendar";
import { EmptyState, Skeleton } from "@smithers-orchestrator/ui";
import { ensureGatewayUiStyles, theme } from "./theme";
import { WorkflowPicker } from "./WorkflowPicker";

export type CronCalendarProps = {
  /** Days of upcoming occurrences to expand, starting today (default 35). */
  windowDays?: number;
  /** Initial Calendar view (default "month"); the user can switch views after mount. */
  view?: CalendarView;
  /** Called with the cronId when one of its occurrence chips is clicked. */
  onCronSelect?: (cronId: string) => void;
  /** Called after the quick-create form successfully registers a cron. */
  onCreated?: (cronId: string | undefined) => void;
  className?: string;
  style?: CSSProperties;
  /**
   * Test seam: the schedule hook to read from. Defaults to {@link useCronSchedule}.
   * @internal
   */
  useSchedule?: typeof useCronSchedule;
  /**
   * Test seam: the actions hook to mutate with. Defaults to {@link useGatewayActions}.
   * @internal
   */
  useActions?: typeof useGatewayActions;
};

const labelStyle: CSSProperties = {
  display: "grid",
  gap: 4,
  color: theme.textDim,
  fontSize: 11,
  fontWeight: 650,
  textTransform: "uppercase",
  letterSpacing: "0.05em",
};

const inputStyle: CSSProperties = {
  minHeight: 32,
  padding: "0 10px",
  borderRadius: 6,
  border: `1px solid ${theme.border}`,
  background: theme.panel,
  color: theme.text,
  fontFamily: theme.fontSans,
  fontSize: 13,
  textTransform: "none",
  letterSpacing: "normal",
};

const launchStyle: CSSProperties = {
  padding: "8px 16px",
  borderRadius: theme.radius,
  border: "none",
  background: theme.accent,
  color: "var(--inverse-text, #fafafa)",
  fontFamily: theme.fontSans,
  fontWeight: 600,
  fontSize: 13,
};

/** The cronId half of a `${cronId}:${occurrenceMs}` event id. */
function cronIdFromEvent(event: CronScheduleEvent): string {
  const index = event.id.lastIndexOf(":");
  return index === -1 ? event.id : event.id.slice(0, index);
}

/**
 * A Google-Calendar-style view of the gateway's cron schedules: expands each
 * cron's upcoming occurrences via {@link useCronSchedule} onto the shared
 * Calendar. Clicking an occurrence reports its cronId; clicking an empty slot
 * opens a quick-create form (pattern prefilled from the slot's wall-clock
 * time) that registers the cron through `cronCreate`.
 */
export function CronCalendar({
  windowDays = 35,
  view,
  onCronSelect,
  onCreated,
  className,
  style,
  useSchedule = useCronSchedule,
  useActions = useGatewayActions,
}: CronCalendarProps) {
  useInsertionEffect(ensureGatewayUiStyles, []);
  const { windowStart, windowEnd } = useMemo(() => {
    const start = startOfDay(Date.now());
    return { windowStart: start, windowEnd: start + windowDays * DAY_MS };
  }, [windowDays]);
  const { data, loading, error, refetch } = useSchedule({ windowStart, windowEnd });
  const actions = useActions();

  const [formOpen, setFormOpen] = useState(false);
  const [name, setName] = useState("");
  const [pattern, setPattern] = useState("");
  const [workflow, setWorkflow] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const events = data ?? [];

  function openCreate(date?: number) {
    if (date !== undefined) {
      const d = new Date(date);
      setPattern(`${d.getMinutes()} ${d.getHours()} * * *`);
    }
    setFormError(null);
    setFormOpen(true);
  }

  async function create() {
    if (!workflow) {
      setFormError("Choose a workflow.");
      return;
    }
    try {
      parseCronPattern(pattern);
    } catch (cause) {
      setFormError(cause instanceof Error ? cause.message : "Invalid cron expression.");
      return;
    }
    setBusy(true);
    setFormError(null);
    try {
      const result = await actions.cronCreate({ workflow, pattern, ...(name.trim() ? { cronId: name.trim() } : {}) });
      const cronId = (result as { cronId?: string } | undefined)?.cronId;
      setFormOpen(false);
      setName("");
      setPattern("");
      setWorkflow("");
      await refetch();
      onCreated?.(cronId);
    } catch (cause) {
      setFormError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className={className}
      style={{
        display: "grid",
        alignContent: "start",
        gap: 10,
        fontFamily: theme.fontSans,
        color: theme.text,
        ...style,
      }}
    >
      {error ? (
        <div
          role="alert"
          style={{
            padding: 12,
            border: `1px solid ${theme.dangerBorder}`,
            borderRadius: theme.radius,
            background: theme.dangerSoft,
            color: theme.danger,
            fontSize: 13,
          }}
        >
          {error.message ?? "Failed to load the cron schedule."}
        </div>
      ) : null}
      {loading && !data ? (
        <div role="status" aria-label="Loading cron schedule" style={{ display: "grid", gap: 10 }}>
          <Skeleton style={{ height: 32, borderRadius: theme.radius }} />
          <Skeleton style={{ height: 420, borderRadius: theme.radius }} />
        </div>
      ) : null}
      {data ? (
        events.length === 0 ? (
          <EmptyState
            title="No scheduled runs"
            description="Create your first cron to see upcoming runs on the calendar."
            action={
              <button type="button" className="gw-launch-button" style={launchStyle} onClick={() => openCreate()}>
                Create cron
              </button>
            }
          />
        ) : (
          <Calendar
            events={events}
            defaultView={view ?? "month"}
            onEventClick={(event) => onCronSelect?.(cronIdFromEvent(event))}
            onSlotClick={(date) => openCreate(date)}
          />
        )
      ) : null}
      {formOpen ? (
        <form
          aria-label="Create cron"
          onSubmit={(submit) => {
            submit.preventDefault();
            void create();
          }}
          style={{
            display: "grid",
            gap: 8,
            padding: 12,
            border: `1px solid ${theme.border}`,
            borderRadius: theme.radius,
            background: theme.panel,
          }}
        >
          <div style={{ fontSize: 13, fontWeight: 650 }}>New cron</div>
          <label style={labelStyle}>
            Name (optional)
            <input
              value={name}
              onChange={(event) => setName(event.currentTarget.value)}
              placeholder="nightly-backup"
              style={inputStyle}
            />
          </label>
          <label style={labelStyle}>
            Cron expression
            <input
              value={pattern}
              onChange={(event) => setPattern(event.currentTarget.value)}
              placeholder="0 9 * * *"
              required
              style={{ ...inputStyle, fontFamily: theme.fontMono }}
            />
          </label>
          <label style={labelStyle}>
            Workflow
            <WorkflowPicker value={workflow} onChange={setWorkflow} />
          </label>
          {formError ? (
            <div role="alert" style={{ color: theme.danger, fontSize: 12 }}>
              {formError}
            </div>
          ) : null}
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
            <button
              type="button"
              onClick={() => setFormOpen(false)}
              style={{
                padding: "8px 16px",
                borderRadius: theme.radius,
                border: `1px solid ${theme.border}`,
                background: theme.panel,
                color: theme.text,
                fontFamily: theme.fontSans,
                fontSize: 13,
                cursor: "pointer",
              }}
            >
              Cancel
            </button>
            <button type="submit" className="gw-launch-button" disabled={busy} aria-busy={busy} style={launchStyle}>
              {busy ? "Creating…" : "Create cron"}
            </button>
          </div>
        </form>
      ) : null}
    </div>
  );
}
