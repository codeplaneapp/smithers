/** @jsxImportSource react */
import { useMemo, useState } from "react";
import {
  createGatewayReactRoot,
  useGatewayActions,
  useGatewayNodeOutput,
  useGatewayRunEvents,
  useGatewayRuns,
} from "smithers-orchestrator/gateway-react";
import { WorkflowUiStyles } from "smithers-orchestrator/gateway-ui";
import { sharedDarkThemeCss } from "./shared-theme";

const WORKFLOW_KEY = "tickets-create";

type RunSummary = { runId: string; workflowKey?: string; status?: string; createdAtMs?: number };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
function shortRunId(runId: string | undefined) {
  return runId ? runId.slice(0, 8) : "--";
}
function runIdFromUrl(): string | undefined {
  if (typeof location === "undefined") return undefined;
  return new URLSearchParams(location.search).get("runId") ?? undefined;
}

type Ticket = { title: string; description: string; acceptanceCriteria: string[] };
type TicketsOutput = { summary: string; tickets: Ticket[] };

function extractTickets(value: unknown): TicketsOutput | null {
  const response = isRecord(value) ? value : {};
  const row = isRecord(response.row) ? response.row : isRecord(response) ? response : {};
  const summary = asString(row.summary);
  if (summary === undefined) return null;
  const rawTickets = Array.isArray(row.tickets) ? row.tickets : [];
  const tickets: Ticket[] = rawTickets
    .filter((t): t is Record<string, unknown> => isRecord(t))
    .map((t) => ({
      title: asString(t.title) ?? "Untitled ticket",
      description: asString(t.description) ?? "",
      acceptanceCriteria: Array.isArray(t.acceptanceCriteria)
        ? t.acceptanceCriteria.filter((c): c is string => typeof c === "string")
        : [],
    }));
  return { summary, tickets };
}

const styles = [
  ...sharedDarkThemeCss,
  ".toolbar { display:flex; align-items:center; gap:8px; flex:1; justify-content:flex-end; }",
  ".prompt { flex:1; max-width:420px; height:30px; padding:0 10px; border:1px solid var(--border); border-radius:6px; background:var(--panel); color:var(--text); }",
  ".main { display:grid; grid-template-columns:1fr 280px; flex:1; overflow:hidden; }",
  ".status-row { display:flex; align-items:center; gap:10px; margin-bottom:16px; }",
  ".summary-card { background:var(--card); border:1px solid var(--border); border-radius:10px; padding:18px 20px; margin-bottom:18px; }",
  ".summary-card h2 { margin:0 0 6px; font-size:12px; text-transform:uppercase; letter-spacing:0.04em; color:var(--muted); }",
  ".summary-text { font-size:15px; line-height:1.55; }",
  ".section-head { display:flex; align-items:center; justify-content:space-between; margin:0 0 12px; }",
  ".section-head h2 { margin:0; font-size:12px; text-transform:uppercase; letter-spacing:0.04em; color:var(--muted); }",
  ".count-chip { font-size:11px; color:var(--muted); background:var(--panel); border:1px solid var(--border); border-radius:10px; padding:2px 9px; }",
  ".tickets { display:flex; flex-direction:column; gap:14px; }",
  ".ticket-card { background:var(--card); border:1px solid var(--border); border-radius:10px; padding:16px 18px; }",
  ".ticket-top { display:flex; align-items:flex-start; gap:10px; }",
  ".ticket-idx { flex:0 0 26px; height:26px; border-radius:7px; background:var(--panel); border:1px solid var(--border); display:flex; align-items:center; justify-content:center; font-size:11px; color:var(--muted); }",
  ".ticket-title { font-size:14px; font-weight:600; flex:1; }",
  ".ticket-desc { margin:10px 0 0; color:var(--text); }",
  ".ac-label { margin:14px 0 6px; font-size:11px; text-transform:uppercase; letter-spacing:0.04em; color:var(--muted); }",
  ".ac-list { list-style:none; margin:0; padding:0; }",
  ".ac-list li { display:flex; gap:8px; padding:5px 0; color:var(--text); }",
  ".ac-list li::before { content:'\\2713'; color:var(--ok); flex:0 0 auto; }",
  ".ac-empty { color:var(--muted); font-style:italic; }",
  ".empty .button { margin-top:14px; }",
  ".sidebar { border-left:1px solid var(--border); background:var(--panel); overflow:auto; display:flex; flex-direction:column; }",
  ".run-row { width:100%; text-align:left; padding:10px 16px; border:0; border-bottom:1px solid var(--border); background:transparent; color:var(--text); cursor:pointer; display:flex; justify-content:space-between; gap:8px; }",
  ".events { border-top:1px solid var(--border); margin-top:auto; }",
  ".events-head { width:100%; text-align:left; padding:10px 16px; border:0; background:transparent; color:var(--muted); cursor:pointer; font-size:11px; text-transform:uppercase; letter-spacing:0.04em; display:flex; justify-content:space-between; }",
  ".events-body { max-height:160px; overflow:auto; padding:0 16px 10px; }",
  ".event-line { font-family:ui-monospace,monospace; font-size:11px; color:var(--muted); padding:3px 0; border-bottom:1px solid var(--border); }",
  ".event-line:last-child { border-bottom:0; }",
].join("\n");

function statusClass(status: string | undefined) {
  if (status === "running" || status === "continued") return "running";
  if (status === "finished") return "finished";
  if (status === "failed" || status === "cancelled") return "failed";
  return "";
}

function App() {
  const [selectedRunId, setSelectedRunId] = useState<string | undefined>(runIdFromUrl());
  const [prompt, setPrompt] = useState("Break this work into tickets.");
  const [busy, setBusy] = useState(false);
  const [eventsOpen, setEventsOpen] = useState(true);
  const runsQuery = useGatewayRuns({ filter: { limit: 20 } });
  const actions = useGatewayActions();

  const ticketRuns = useMemo(
    () => ((runsQuery.data ?? []) as RunSummary[]).filter((r) => !r.workflowKey || r.workflowKey === WORKFLOW_KEY),
    [runsQuery.data],
  );
  const activeRunId = selectedRunId ?? runIdFromUrl() ?? ticketRuns[0]?.runId;
  const activeRun = ticketRuns.find((r) => r.runId === activeRunId);
  const stream = useGatewayRunEvents(activeRunId, { afterSeq: undefined });
  const ticketsOutput = useGatewayNodeOutput({ runId: activeRunId, nodeId: "tickets", iteration: 0 });
  const result = useMemo(() => extractTickets(ticketsOutput.data), [ticketsOutput.data]);
  const events = stream.events ?? [];
  const running = statusClass(activeRun?.status) === "running";

  async function refresh() {
    await Promise.all([runsQuery.refetch(), ticketsOutput.refetch()]);
  }
  async function launch() {
    setBusy(true);
    try {
      const run = await actions.launchRun({ workflow: WORKFLOW_KEY, input: { prompt } });
      setSelectedRunId(run.runId);
      await refresh();
    } finally {
      setBusy(false);
    }
  }
  async function cancel() {
    if (!activeRunId) return;
    setBusy(true);
    try {
      await actions.cancelRun({ runId: activeRunId });
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="shell" data-testid="tickets-create-ui">
      <style>{styles}</style>
      <WorkflowUiStyles mode="theme" />
      <header className="topbar">
        <div className="title-group">
          <h1>Tickets Create</h1>
          <span className="pill" data-testid="tickets-create-runid">
            {activeRunId ? shortRunId(activeRunId) : "No run"}
          </span>
          {activeRun ? (
            <span className={"badge " + statusClass(activeRun.status)} data-testid="tickets-create-status">
              {activeRun.status ?? "idle"}
            </span>
          ) : null}
        </div>
        <div className="toolbar">
          <input
            className="prompt"
            data-testid="tickets-create-prompt"
            value={prompt}
            onChange={(e) => setPrompt(e.currentTarget.value)}
            placeholder="What work should we break into tickets?"
          />
          <button
            className="button"
            data-testid="tickets-create-refresh"
            onClick={() => void refresh()}
            disabled={busy}
          >
            Refresh
          </button>
          {running ? (
            <button
              className="button danger"
              data-testid="tickets-create-cancel"
              onClick={() => void cancel()}
              disabled={busy}
            >
              Cancel
            </button>
          ) : null}
          <button
            className="button primary"
            data-testid="tickets-create-launch"
            onClick={() => void launch()}
            disabled={busy}
          >
            Generate Tickets
          </button>
        </div>
      </header>

      <div className="main">
        <div className="content">
          {result ? (
            <>
              <div className="summary-card" data-testid="tickets-create-summary-panel">
                <h2>Breakdown summary</h2>
                <div className="summary-text" data-testid="tickets-create-summary">
                  {result.summary}
                </div>
              </div>

              <div className="section-head">
                <h2>Tickets</h2>
                <span className="count-chip" data-testid="tickets-create-count">
                  {result.tickets.length}
                </span>
              </div>

              {result.tickets.length > 0 ? (
                <div className="tickets" data-testid="tickets-create-tickets">
                  {result.tickets.map((ticket, i) => (
                    <article className="ticket-card" data-testid="tickets-create-ticket" key={i}>
                      <div className="ticket-top">
                        <span className="ticket-idx">{i + 1}</span>
                        <span className="ticket-title">{ticket.title}</span>
                      </div>
                      {ticket.description ? <p className="ticket-desc">{ticket.description}</p> : null}
                      <div className="ac-label">Acceptance criteria</div>
                      {ticket.acceptanceCriteria.length > 0 ? (
                        <ul className="ac-list">
                          {ticket.acceptanceCriteria.map((c, j) => (
                            <li key={j}>{c}</li>
                          ))}
                        </ul>
                      ) : (
                        <div className="ac-empty">No acceptance criteria specified.</div>
                      )}
                    </article>
                  ))}
                </div>
              ) : (
                <div className="empty" data-testid="tickets-create-tickets-empty">
                  <div>No tickets were generated for this run.</div>
                  <div style={{ marginTop: 6, fontSize: 12 }}>
                    The summary is shown above; try a more specific request.
                  </div>
                </div>
              )}
            </>
          ) : (
            <div className="empty" data-testid="tickets-create-empty">
              <div>
                {activeRunId ? (running ? "Generating tickets…" : "Waiting for ticket output…") : "No tickets yet."}
              </div>
              <button
                className="button primary"
                data-testid="tickets-create-launch-empty"
                onClick={() => void launch()}
                disabled={busy}
              >
                Generate Tickets
              </button>
            </div>
          )}
        </div>

        <aside className="sidebar">
          <div className="side-head">Recent runs</div>
          {ticketRuns.map((r) => (
            <button
              key={r.runId}
              className={"run-row" + (r.runId === activeRunId ? " active" : "")}
              data-testid={"tickets-create-run-" + r.runId}
              onClick={() => setSelectedRunId(r.runId)}
            >
              <span className="mono">{shortRunId(r.runId)}</span>
              <span className={"badge " + statusClass(r.status)}>{r.status ?? "?"}</span>
            </button>
          ))}
          {ticketRuns.length === 0 ? <div className="empty">No runs yet.</div> : null}

          <div className="events" data-testid="tickets-create-events">
            <button className="events-head" onClick={() => setEventsOpen((v) => !v)}>
              <span>Live events ({events.length})</span>
              <span>{eventsOpen ? "Hide" : "Show"}</span>
            </button>
            {eventsOpen ? (
              <div className="events-body">
                {events.length > 0 ? (
                  events.slice(-30).map((ev, i) => (
                    <div className="event-line" key={i}>
                      {asString((ev as Record<string, unknown>).type) ?? "event"}
                    </div>
                  ))
                ) : (
                  <div className="event-line">No events yet.</div>
                )}
              </div>
            ) : null}
          </div>
        </aside>
      </div>
    </main>
  );
}

createGatewayReactRoot(<App />);
