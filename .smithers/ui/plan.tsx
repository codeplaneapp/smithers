/** @jsxImportSource react */
import { useMemo, useState } from "react";
import {
  createGatewayReactRoot,
  useGatewayActions,
  useGatewayNodeOutput,
  useGatewayRunEvents,
  useGatewayRuns,
} from "smithers-orchestrator/gateway-react";

const WORKFLOW_KEY = "plan";

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

type PlanOutput = { summary: string; steps: string[] };
function extractPlan(value: unknown): PlanOutput | null {
  const response = isRecord(value) ? value : {};
  const row = isRecord(response.row) ? response.row : isRecord(response) ? response : {};
  const summary = asString(row.summary);
  if (summary === undefined) return null;
  const steps = Array.isArray(row.steps) ? row.steps.filter((s): s is string => typeof s === "string") : [];
  return { summary, steps };
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
  ".pill { display:inline-flex; align-items:center; gap:6px; font-size:12px; color:var(--muted); background:var(--panel); padding:4px 10px; border-radius:6px; border:1px solid var(--border); }",
  ".toolbar { display:flex; align-items:center; gap:8px; flex:1; justify-content:flex-end; }",
  ".prompt { flex:1; max-width:420px; height:30px; padding:0 10px; border:1px solid var(--border); border-radius:6px; background:var(--panel); color:var(--text); }",
  ".button { height:30px; padding:0 12px; border:1px solid var(--border); border-radius:6px; background:var(--panel); color:var(--text); cursor:pointer; font-weight:500; }",
  ".button:hover { background:var(--card); }",
  ".button.primary { background:var(--primary); color:#fff; border-color:var(--primary); }",
  ".button.danger { color:var(--err); }",
  ".button:disabled { opacity:0.4; cursor:not-allowed; }",
  ".main { display:grid; grid-template-columns:1fr 280px; flex:1; overflow:hidden; }",
  ".content { padding:20px; overflow:auto; }",
  ".status-row { display:flex; align-items:center; gap:10px; margin-bottom:16px; }",
  ".badge { font-size:11px; font-weight:600; text-transform:uppercase; padding:3px 8px; border-radius:5px; border:1px solid var(--border); }",
  ".badge.running { color:var(--warn); border-color:var(--warn); }",
  ".badge.finished { color:var(--ok); border-color:var(--ok); }",
  ".badge.failed { color:var(--err); border-color:var(--err); }",
  ".summary-card { background:var(--card); border:1px solid var(--border); border-radius:10px; padding:18px 20px; margin-bottom:18px; }",
  ".summary-card h2 { margin:0 0 6px; font-size:12px; text-transform:uppercase; letter-spacing:0.04em; color:var(--muted); }",
  ".summary-text { font-size:15px; line-height:1.55; }",
  ".steps { list-style:none; margin:0; padding:0; counter-reset:step; }",
  ".steps li { display:flex; gap:12px; padding:12px 0; border-bottom:1px solid var(--border); }",
  ".steps li:last-child { border-bottom:0; }",
  ".step-num { flex:0 0 24px; height:24px; border-radius:50%; background:var(--panel); border:1px solid var(--border); display:flex; align-items:center; justify-content:center; font-size:11px; color:var(--muted); }",
  ".empty { color:var(--muted); text-align:center; padding:48px 16px; }",
  ".empty .button { margin-top:14px; }",
  ".sidebar { border-left:1px solid var(--border); background:var(--panel); overflow:auto; }",
  ".side-head { padding:12px 16px; font-size:11px; text-transform:uppercase; letter-spacing:0.04em; color:var(--muted); border-bottom:1px solid var(--border); }",
  ".run-row { width:100%; text-align:left; padding:10px 16px; border:0; border-bottom:1px solid var(--border); background:transparent; color:var(--text); cursor:pointer; display:flex; justify-content:space-between; gap:8px; }",
  ".run-row:hover { background:var(--card); }",
  ".run-row.active { background:var(--card); box-shadow:inset 2px 0 0 var(--primary); }",
  ".run-row .mono { font-family:ui-monospace,monospace; font-size:11px; }",
].join("\n");

function statusClass(status: string | undefined) {
  if (status === "running" || status === "continued") return "running";
  if (status === "finished") return "finished";
  if (status === "failed" || status === "cancelled") return "failed";
  return "";
}

function App() {
  const [selectedRunId, setSelectedRunId] = useState<string | undefined>(runIdFromUrl());
  const [prompt, setPrompt] = useState("Create an implementation plan.");
  const [busy, setBusy] = useState(false);
  const runsQuery = useGatewayRuns({ filter: { limit: 20 } });
  const actions = useGatewayActions();

  const planRuns = useMemo(
    () => ((runsQuery.data ?? []) as RunSummary[]).filter((r) => !r.workflowKey || r.workflowKey === WORKFLOW_KEY),
    [runsQuery.data],
  );
  const activeRunId = selectedRunId ?? planRuns[0]?.runId;
  const activeRun = planRuns.find((r) => r.runId === activeRunId);
  const stream = useGatewayRunEvents(activeRunId, { afterSeq: 0 });
  // The plan is now a synthesized panel: read the moderator's merged plan.
  const planOutput = useGatewayNodeOutput({ runId: activeRunId, nodeId: "plan-moderator", iteration: 0 });
  const plan = useMemo(() => extractPlan(planOutput.data), [planOutput.data]);
  const eventCount = (stream.events ?? []).length;

  async function refresh() {
    await Promise.all([runsQuery.refetch(), planOutput.refetch()]);
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
    <main className="shell" data-testid="plan-ui">
      <style>{styles}</style>
      <header className="topbar">
        <div className="title-group">
          <h1>Plan</h1>
          <span className="pill" data-testid="plan-runid">{activeRunId ? shortRunId(activeRunId) : "No run"}</span>
          {activeRun ? (
            <span className={"badge " + statusClass(activeRun.status)} data-testid="plan-status">{activeRun.status ?? "idle"}</span>
          ) : null}
        </div>
        <div className="toolbar">
          <input
            className="prompt"
            data-testid="plan-prompt"
            value={prompt}
            onChange={(e) => setPrompt(e.currentTarget.value)}
            placeholder="What should we plan?"
          />
          <button className="button" data-testid="plan-refresh" onClick={() => void refresh()} disabled={busy}>Refresh</button>
          {activeRun && statusClass(activeRun.status) === "running" ? (
            <button className="button danger" data-testid="plan-cancel" onClick={() => void cancel()} disabled={busy}>Cancel</button>
          ) : null}
          <button className="button primary" data-testid="plan-launch" onClick={() => void launch()} disabled={busy}>Generate Plan</button>
        </div>
      </header>

      <div className="main">
        <div className="content">
          {plan ? (
            <>
              <div className="summary-card">
                <h2>Plan summary</h2>
                <div className="summary-text" data-testid="plan-summary">{plan.summary}</div>
              </div>
              <ol className="steps" data-testid="plan-steps">
                {plan.steps.map((step, i) => (
                  <li key={i} data-testid="plan-step">
                    <span className="step-num">{i + 1}</span>
                    <span>{step}</span>
                  </li>
                ))}
                {plan.steps.length === 0 ? <li className="empty">No steps in this plan.</li> : null}
              </ol>
              <div className="status-row" style={{ marginTop: 16, color: "var(--muted)" }}>
                <span>{eventCount} events</span>
                {planOutput.loading ? <span>· refreshing…</span> : null}
              </div>
            </>
          ) : (
            <div className="empty" data-testid="plan-empty">
              <div>{activeRunId ? "Waiting for the plan…" : "No plan yet."}</div>
              <button className="button primary" data-testid="plan-launch-empty" onClick={() => void launch()} disabled={busy}>
                Generate Plan
              </button>
            </div>
          )}
        </div>

        <aside className="sidebar">
          <div className="side-head">Recent plans</div>
          {planRuns.map((r) => (
            <button
              key={r.runId}
              className={"run-row" + (r.runId === activeRunId ? " active" : "")}
              data-testid={"plan-run-" + r.runId}
              onClick={() => setSelectedRunId(r.runId)}
            >
              <span className="mono">{shortRunId(r.runId)}</span>
              <span className={"badge " + statusClass(r.status)}>{r.status ?? "?"}</span>
            </button>
          ))}
          {planRuns.length === 0 ? <div className="empty">No runs yet.</div> : null}
        </aside>
      </div>
    </main>
  );
}

createGatewayReactRoot(<App />);
