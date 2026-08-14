/** @jsxImportSource react */
import { useMemo, useState } from "react";
import {
  createGatewayReactRoot,
  useGatewayActions,
  useGatewayNodeOutput,
  useGatewayRunEvents,
  useGatewayRuns,
} from "smthrs/gateway-react";
import { WorkflowUiStyles } from "smthrs/gateway-ui";

const WORKFLOW_KEY = "ticket-create";

type RunSummary = { runId: string; workflowKey?: string; status?: string; createdAtMs?: number; input?: unknown };

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
function statusClass(status: string | undefined) {
  if (status === "running" || status === "continued") return "running";
  if (status === "finished") return "finished";
  if (status === "failed" || status === "cancelled") return "failed";
  return "";
}

type Ticket = { title: string; description: string; acceptanceCriteria: string[] };
function extractTicket(value: unknown): Ticket | null {
  const response = isRecord(value) ? value : {};
  const data = isRecord(response.data) ? response.data : response;
  const row = isRecord(data.row) ? data.row : isRecord(data) ? data : {};
  const title = asString(row.title);
  const description = asString(row.description);
  if (title === undefined && description === undefined) return null;
  const acceptanceCriteria = Array.isArray(row.acceptanceCriteria)
    ? row.acceptanceCriteria.filter((c): c is string => typeof c === "string")
    : [];
  return { title: title ?? "", description: description ?? "", acceptanceCriteria };
}

function inputPrompt(run: RunSummary | undefined): string | undefined {
  if (!run) return undefined;
  const input = isRecord(run.input) ? run.input : undefined;
  return input ? asString(input.prompt) : undefined;
}

function ticketMarkdown(ticket: Ticket): string {
  const lines = ["# " + ticket.title, "", ticket.description, ""];
  if (ticket.acceptanceCriteria.length > 0) {
    lines.push("## Acceptance Criteria", "");
    for (const c of ticket.acceptanceCriteria) lines.push("- [ ] " + c);
  }
  return lines.join("\n");
}

function copyText(text: string) {
  if (typeof navigator !== "undefined" && navigator.clipboard) {
    void navigator.clipboard.writeText(text);
  }
}

const styles = [
  ":root { --bg:#0c0c0e; --panel:#151518; --card:#1c1c1f; --text:#eee; --muted:#8a8a8e; --border:#262629; --primary:#5e6ad2; --ok:#4ade80; --err:#f87171; --warn:#fbbf24; color-scheme:dark; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif; }",
  "* { box-sizing:border-box; }",
  "body { margin:0; background:var(--bg); color:var(--text); font-size:13px; line-height:1.5; }",
  "button,input { font:inherit; }",
  ".shell { height:100vh; display:flex; flex-direction:column; overflow:hidden; }",
  ".topbar { display:flex; align-items:center; justify-content:space-between; gap:16px; padding:12px 20px; border-bottom:1px solid var(--border); }",
  ".title-group { display:flex; align-items:center; gap:12px; min-width:0; }",
  "h1 { margin:0; font-size:14px; font-weight:600; }",
  ".pill { display:inline-flex; align-items:center; gap:6px; font-size:12px; color:var(--muted); background:var(--panel); padding:4px 10px; border-radius:6px; border:1px solid var(--border); font-family:ui-monospace,monospace; }",
  ".toolbar { display:flex; align-items:center; gap:8px; flex:1; justify-content:flex-end; }",
  ".prompt { flex:1; max-width:420px; height:30px; padding:0 10px; border:1px solid var(--border); border-radius:6px; background:var(--panel); color:var(--text); }",
  ".button { height:30px; padding:0 12px; border:1px solid var(--border); border-radius:6px; background:var(--panel); color:var(--text); cursor:pointer; font-weight:500; }",
  ".button:hover { background:var(--card); }",
  ".button.primary { background:var(--primary); color:#fff; border-color:var(--primary); }",
  ".button.danger { color:var(--err); }",
  ".button:disabled { opacity:0.4; cursor:not-allowed; }",
  ".button.tiny { height:24px; padding:0 8px; font-size:11px; }",
  ".badge { font-size:11px; font-weight:600; text-transform:uppercase; padding:3px 8px; border-radius:5px; border:1px solid var(--border); }",
  ".badge.running { color:var(--warn); border-color:var(--warn); }",
  ".badge.finished { color:var(--ok); border-color:var(--ok); }",
  ".badge.failed { color:var(--err); border-color:var(--err); }",
  ".main { display:grid; grid-template-columns:1fr 280px; flex:1; overflow:hidden; }",
  ".content { padding:24px; overflow:auto; display:flex; flex-direction:column; align-items:center; }",
  ".col { width:100%; max-width:680px; }",
  ".request { background:var(--panel); border:1px solid var(--border); border-radius:8px; padding:10px 14px; margin-bottom:16px; }",
  ".request .label { font-size:10px; text-transform:uppercase; letter-spacing:0.06em; color:var(--muted); margin-bottom:4px; }",
  ".request .text { font-size:13px; }",
  ".status-row { display:flex; align-items:center; gap:10px; margin-bottom:18px; }",
  ".status-msg { color:var(--muted); font-size:12px; }",
  ".ticket-card { background:var(--card); border:1px solid var(--border); border-radius:12px; padding:24px 26px; margin-bottom:18px; }",
  ".ticket-head { display:flex; align-items:flex-start; justify-content:space-between; gap:16px; margin-bottom:14px; }",
  ".ticket-title { margin:0; font-size:20px; font-weight:650; line-height:1.3; }",
  ".ticket-section { margin-top:18px; }",
  ".ticket-section h3 { margin:0 0 8px; font-size:11px; text-transform:uppercase; letter-spacing:0.06em; color:var(--muted); display:flex; align-items:center; justify-content:space-between; }",
  ".ticket-desc { font-size:14px; line-height:1.6; white-space:pre-wrap; }",
  ".ac-list { list-style:none; margin:0; padding:0; }",
  ".ac-list li { display:flex; gap:10px; padding:9px 0; border-bottom:1px solid var(--border); align-items:flex-start; }",
  ".ac-list li:last-child { border-bottom:0; }",
  ".ac-check { flex:0 0 auto; width:18px; height:18px; border-radius:5px; border:1px solid var(--border); background:var(--panel); cursor:pointer; display:flex; align-items:center; justify-content:center; font-size:11px; color:var(--ok); padding:0; }",
  ".ac-check.done { border-color:var(--ok); }",
  ".ac-text { flex:1; }",
  ".ac-text.done { color:var(--muted); text-decoration:line-through; }",
  ".ac-empty { color:var(--muted); font-size:13px; padding:6px 0; }",
  ".actions-footer { display:flex; gap:8px; flex-wrap:wrap; padding-top:4px; }",
  ".empty { color:var(--muted); text-align:center; padding:48px 16px; }",
  ".empty h2 { color:var(--text); font-size:16px; margin:0 0 6px; }",
  ".empty .form { display:flex; flex-direction:column; gap:10px; max-width:420px; margin:18px auto 0; }",
  ".empty textarea { min-height:84px; padding:10px 12px; border:1px solid var(--border); border-radius:8px; background:var(--panel); color:var(--text); resize:vertical; }",
  ".sidebar { border-left:1px solid var(--border); background:var(--panel); overflow:auto; }",
  ".side-head { padding:12px 16px; font-size:11px; text-transform:uppercase; letter-spacing:0.04em; color:var(--muted); border-bottom:1px solid var(--border); }",
  ".run-row { width:100%; text-align:left; padding:10px 16px; border:0; border-bottom:1px solid var(--border); background:transparent; color:var(--text); cursor:pointer; display:flex; justify-content:space-between; gap:8px; }",
  ".run-row:hover { background:var(--card); }",
  ".run-row.active { background:var(--card); box-shadow:inset 2px 0 0 var(--primary); }",
  ".run-row .mono { font-family:ui-monospace,monospace; font-size:11px; }",
].join("\n");

function App() {
  const [selectedRunId, setSelectedRunId] = useState<string | undefined>(runIdFromUrl());
  const [prompt, setPrompt] = useState("Create a ticket for the requested work.");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<Record<string, boolean>>({});
  const runsQuery = useGatewayRuns({ filter: { limit: 20 } });
  const actions = useGatewayActions();

  const ticketRuns = useMemo(
    () => ((runsQuery.data ?? []) as RunSummary[]).filter((r) => !r.workflowKey || r.workflowKey === WORKFLOW_KEY),
    [runsQuery.data],
  );
  const activeRunId = selectedRunId ?? runIdFromUrl() ?? ticketRuns[0]?.runId;
  const activeRun = ticketRuns.find((r) => r.runId === activeRunId);
  const stream = useGatewayRunEvents(activeRunId, { afterSeq: 0 });
  const ticketOutput = useGatewayNodeOutput({ runId: activeRunId, nodeId: "ticket", iteration: 0 });
  const ticket = useMemo(() => extractTicket(ticketOutput.data), [ticketOutput.data]);
  const requestText = inputPrompt(activeRun);
  const eventCount = (stream.events ?? []).length;
  const running = statusClass(activeRun?.status) === "running";
  const failed = statusClass(activeRun?.status) === "failed";

  async function refresh() {
    await Promise.all([runsQuery.refetch(), ticketOutput.refetch()]);
  }
  async function launch() {
    setBusy(true);
    try {
      const run = await actions.launchRun({ workflow: WORKFLOW_KEY, input: { prompt } });
      setSelectedRunId(run.runId);
      setDone({});
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
  function toggleDone(key: string) {
    setDone((prev) => ({ ...prev, [key]: !prev[key] }));
  }

  return (
    <main className="shell" data-testid="ticket-create-ui">
      <style>{styles}</style>
      <WorkflowUiStyles mode="theme" />
      <header className="topbar">
        <div className="title-group">
          <h1>Ticket Create</h1>
          <span className="pill" data-testid="ticket-create-runid">{activeRunId ? shortRunId(activeRunId) : "No run"}</span>
          {activeRun ? (
            <span className={"badge " + statusClass(activeRun.status)} data-testid="ticket-create-status">{activeRun.status ?? "idle"}</span>
          ) : null}
        </div>
        <div className="toolbar">
          <input
            className="prompt"
            data-testid="ticket-create-prompt"
            value={prompt}
            onChange={(e) => setPrompt(e.currentTarget.value)}
            placeholder="Describe the work to ticket…"
          />
          <button className="button" data-testid="ticket-create-refresh" onClick={() => void refresh()} disabled={busy}>Refresh</button>
          {running ? (
            <button className="button danger" data-testid="ticket-create-cancel" onClick={() => void cancel()} disabled={busy}>Cancel</button>
          ) : null}
          <button className="button primary" data-testid="ticket-create-launch" onClick={() => void launch()} disabled={busy}>Generate Ticket</button>
        </div>
      </header>

      <div className="main">
        <div className="content">
          <div className="col">
            {requestText ? (
              <div className="request" data-testid="ticket-create-request">
                <div className="label">Request</div>
                <div className="text">{requestText}</div>
              </div>
            ) : null}

            <div className="status-row" data-testid="ticket-create-generation-status">
              {running ? <span className="badge running">Generating…</span> : null}
              {!running && ticket ? <span className="badge finished">Ready</span> : null}
              {failed ? <span className="badge failed">Failed</span> : null}
              <span className="status-msg">{eventCount} events{ticketOutput.loading ? " · refreshing…" : ""}</span>
            </div>

            {ticket ? (
              <div className="ticket-card" data-testid="ticket-create-card">
                <div className="ticket-head">
                  <h2 className="ticket-title" data-testid="ticket-create-title">{ticket.title || "Untitled ticket"}</h2>
                  <button className="button tiny" onClick={() => copyText(ticketMarkdown(ticket))}>Copy all</button>
                </div>

                <div className="ticket-section">
                  <h3>
                    Description
                    <button className="button tiny" onClick={() => copyText(ticket.description)}>Copy</button>
                  </h3>
                  <div className="ticket-desc" data-testid="ticket-create-description">
                    {ticket.description || "No description provided."}
                  </div>
                </div>

                <div className="ticket-section" data-testid="ticket-create-acceptance">
                  <h3>Acceptance Criteria</h3>
                  {ticket.acceptanceCriteria.length > 0 ? (
                    <ul className="ac-list">
                      {ticket.acceptanceCriteria.map((c, i) => {
                        const key = String(i);
                        const checked = !!done[key];
                        return (
                          <li key={i} data-testid="ticket-create-criterion">
                            <button
                              className={"ac-check" + (checked ? " done" : "")}
                              aria-label="toggle done"
                              onClick={() => toggleDone(key)}
                            >
                              {checked ? "✓" : ""}
                            </button>
                            <span className={"ac-text" + (checked ? " done" : "")}>{c}</span>
                          </li>
                        );
                      })}
                    </ul>
                  ) : (
                    <div className="ac-empty">No acceptance criteria were generated for this ticket.</div>
                  )}
                </div>

                <div className="ticket-section actions-footer">
                  <button className="button" onClick={() => void launch()} disabled={busy}>Regenerate</button>
                  <button className="button" onClick={() => copyText(ticketMarkdown(ticket))}>Copy Markdown</button>
                  {running ? <button className="button danger" onClick={() => void cancel()} disabled={busy}>Cancel</button> : null}
                </div>
              </div>
            ) : (
              <div className="empty" data-testid="ticket-create-empty">
                {failed ? (
                  <>
                    <h2>Generation failed</h2>
                    <div>Something went wrong producing this ticket.</div>
                    <button className="button primary" style={{ marginTop: 14 }} onClick={() => void launch()} disabled={busy}>Try Again</button>
                  </>
                ) : running || activeRunId ? (
                  <>
                    <h2>{running ? "Generating ticket…" : "Waiting for the ticket…"}</h2>
                    <div>The agent is turning the request into a structured ticket.</div>
                  </>
                ) : (
                  <>
                    <h2>No ticket yet</h2>
                    <div>Describe the work you want captured and generate a ticket.</div>
                    <div className="form">
                      <textarea
                        data-testid="ticket-create-empty-input"
                        value={prompt}
                        onChange={(e) => setPrompt(e.currentTarget.value)}
                        placeholder="e.g. Add rate limiting to the login endpoint…"
                      />
                      <button className="button primary" data-testid="ticket-create-launch-empty" onClick={() => void launch()} disabled={busy}>
                        Generate Ticket
                      </button>
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        </div>

        <aside className="sidebar">
          <div className="side-head">Recent tickets</div>
          {ticketRuns.map((r) => (
            <button
              key={r.runId}
              className={"run-row" + (r.runId === activeRunId ? " active" : "")}
              data-testid={"ticket-create-run-" + r.runId}
              onClick={() => setSelectedRunId(r.runId)}
            >
              <span className="mono">{shortRunId(r.runId)}</span>
              <span className={"badge " + statusClass(r.status)}>{r.status ?? "?"}</span>
            </button>
          ))}
          {ticketRuns.length === 0 ? <div className="empty">No runs yet.</div> : null}
        </aside>
      </div>
    </main>
  );
}

createGatewayReactRoot(<App />);
