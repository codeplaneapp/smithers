/** @jsxImportSource react */
import { useMemo, useState } from "react";
import {
  createGatewayReactRoot,
  useGatewayActions,
  useGatewayNodeOutput,
  useGatewayRun,
  useGatewayRunEvents,
  useGatewayRuns,
} from "smithers-orchestrator/gateway-react";

const WORKFLOW_KEY = "ultragrill";

type RunSummary = { runId: string; workflowKey?: string; status?: string; createdAtMs?: number };

// ── value coercion ─────────────────────────────────────────────────────────
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
function asStringArray(value: unknown): string[] {
  return asArray(value).filter((v): v is string => typeof v === "string");
}
function shortRunId(runId: string | undefined) {
  return runId ? runId.slice(0, 8) : "--";
}
function runIdFromUrl(): string | undefined {
  if (typeof location === "undefined") return undefined;
  return new URLSearchParams(location.search).get("runId") ?? undefined;
}
function rowOf(value: unknown): Record<string, unknown> {
  const data = isRecord(value) ? value : {};
  return isRecord(data.row) ? data.row : data;
}

// Gateway run-event frames wrap the node event two levels deep:
//   { event:"run.event", payload:{ event:"node.finished", payload:{ nodeId }, seq } }
type EventInfo = { nodeId: string; type: string; seq: number };
function eventInfo(ev: unknown): EventInfo {
  const frame = isRecord(ev) ? ev : {};
  const inner = isRecord(frame.payload) ? frame.payload : {};
  const nodePayload = isRecord(inner.payload) ? inner.payload : {};
  return {
    nodeId: asString(nodePayload.nodeId) ?? asString(inner.nodeId) ?? asString(frame.nodeId) ?? "",
    type: asString(inner.event) ?? asString(frame.type) ?? "",
    seq: typeof inner.seq === "number" ? inner.seq : typeof frame.seq === "number" ? frame.seq : 0,
  };
}
function workerIndex(nodeId: string): number | null {
  const m = nodeId.match(/^worker:(\d+)$/);
  return m ? Number(m[1]) : null;
}
function classify(type: string): "active" | "done" | "failed" | "" {
  if (type.includes("fail") || type.includes("error")) return "failed";
  if (type.includes("finish") || type.includes("complete")) return "done";
  if (type.includes("start")) return "active";
  return "";
}

type Work = { summary: string; artifact: string; questions: string[] };
function extractWork(value: unknown): Work | null {
  const row = rowOf(value);
  const summary = asString(row.summary);
  if (summary === undefined) return null;
  return { summary, artifact: asString(row.artifact) ?? "", questions: asStringArray(row.questions) };
}

// ── tiny markdown renderer (markdown-first, HTML-rendered — D7) ─────────────
function Markdown(props: { text: string }) {
  const blocks = props.text.split("\n");
  return (
    <div className="md">
      {blocks.map((line, i) => {
        const h = line.match(/^(#{1,4})\s+(.*)$/);
        if (h) {
          const lvl = h[1].length;
          return <div key={i} className={"md-h md-h" + lvl}>{h[2]}</div>;
        }
        const li = line.match(/^\s*[-*]\s+(.*)$/);
        if (li) return <div key={i} className="md-li">• {li[1]}</div>;
        if (line.trim() === "") return <div key={i} className="md-sp" />;
        return <div key={i} className="md-p">{line}</div>;
      })}
    </div>
  );
}

const styles = [
  ":root { --bg:#0c0c0e; --panel:#151518; --card:#1c1c1f; --text:#eee; --muted:#8a8a8e; --border:#262629; --primary:#5e6ad2; --ok:#4ade80; --err:#f87171; --warn:#fbbf24; --me:#2a2f4a; color-scheme:dark; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif; }",
  "* { box-sizing:border-box; }",
  "body { margin:0; background:var(--bg); color:var(--text); font-size:13px; line-height:1.5; }",
  "button,input,textarea { font:inherit; }",
  ".shell { height:100vh; display:flex; flex-direction:column; overflow:hidden; }",
  ".topbar { display:flex; align-items:center; justify-content:space-between; gap:16px; padding:12px 20px; border-bottom:1px solid var(--border); flex-wrap:wrap; }",
  ".title-group { display:flex; align-items:center; gap:10px; min-width:0; }",
  "h1 { margin:0; font-size:14px; font-weight:600; letter-spacing:0.02em; }",
  ".pill { display:inline-flex; align-items:center; gap:6px; font-size:12px; color:var(--muted); background:var(--panel); padding:4px 10px; border-radius:6px; border:1px solid var(--border); }",
  ".pill .mono { font-family:ui-monospace,monospace; }",
  ".badge { font-size:11px; font-weight:600; text-transform:uppercase; padding:3px 8px; border-radius:5px; border:1px solid var(--border); }",
  ".badge.running { color:var(--warn); border-color:var(--warn); }",
  ".badge.finished { color:var(--ok); border-color:var(--ok); }",
  ".badge.failed, .badge.cancelled { color:var(--err); border-color:var(--err); }",
  ".toolbar { display:flex; align-items:center; gap:8px; }",
  ".button { height:30px; padding:0 12px; border:1px solid var(--border); border-radius:6px; background:var(--panel); color:var(--text); cursor:pointer; font-weight:500; }",
  ".button:hover { background:var(--card); }",
  ".button.primary { background:var(--primary); color:#fff; border-color:var(--primary); }",
  ".button.danger { color:var(--err); border-color:var(--err); }",
  ".button:disabled { opacity:0.4; cursor:not-allowed; }",
  ".main { display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1fr); flex:1; overflow:hidden; }",
  "@media (max-width:900px){ .main { grid-template-columns:1fr; overflow:auto; } }",
  ".col { display:flex; flex-direction:column; min-height:0; overflow:hidden; }",
  ".col.right { border-left:1px solid var(--border); }",
  ".col-head { padding:11px 18px; font-size:11px; text-transform:uppercase; letter-spacing:0.05em; color:var(--muted); border-bottom:1px solid var(--border); display:flex; justify-content:space-between; gap:8px; }",
  ".feed { flex:1; overflow:auto; padding:14px 18px; display:flex; flex-direction:column; gap:8px; }",
  ".msg { max-width:90%; padding:8px 12px; border-radius:10px; border:1px solid var(--border); }",
  ".msg.me { align-self:flex-end; background:var(--me); border-color:#39406b; }",
  ".msg.worker { align-self:flex-start; background:var(--card); }",
  ".msg .who { font-size:10px; text-transform:uppercase; letter-spacing:0.05em; color:var(--muted); margin-bottom:3px; }",
  ".activity { align-self:flex-start; font-size:12px; color:var(--muted); display:flex; gap:8px; align-items:baseline; }",
  ".activity .mono { font-family:ui-monospace,monospace; }",
  ".activity .ev.done { color:var(--ok); } .activity .ev.active { color:var(--warn); } .activity .ev.failed { color:var(--err); }",
  ".composer { border-top:1px solid var(--border); padding:12px 16px; display:flex; gap:8px; align-items:flex-end; }",
  ".composer textarea { flex:1; resize:none; min-height:38px; max-height:140px; padding:8px 10px; border:1px solid var(--border); border-radius:8px; background:var(--panel); color:var(--text); }",
  ".artifact { flex:1; overflow:auto; padding:16px 20px; }",
  ".md-h { font-weight:700; margin:12px 0 6px; }",
  ".md-h1 { font-size:17px; } .md-h2 { font-size:15px; } .md-h3,.md-h4 { font-size:13px; color:var(--muted); text-transform:uppercase; letter-spacing:0.04em; }",
  ".md-li { padding:2px 0 2px 4px; } .md-p { padding:2px 0; } .md-sp { height:8px; }",
  ".questions { border-top:1px solid var(--border); padding:14px 18px; max-height:34vh; overflow:auto; }",
  ".questions h2 { margin:0 0 10px; font-size:11px; text-transform:uppercase; letter-spacing:0.05em; color:var(--muted); }",
  ".qcard { background:var(--card); border:1px solid var(--border); border-radius:9px; padding:10px 12px; margin-bottom:8px; display:flex; gap:10px; align-items:flex-start; }",
  ".qcard .q { flex:1; } .qmark { color:var(--primary); }",
  ".empty { margin:auto; max-width:520px; padding:40px 20px; text-align:center; color:var(--muted); }",
  ".launch-form { max-width:520px; margin:48px auto; background:var(--card); border:1px solid var(--border); border-radius:12px; padding:28px; }",
  ".launch-form h2 { margin:0 0 6px; font-size:17px; color:var(--text); }",
  ".launch-form p { margin:0 0 18px; }",
  ".launch-form input { width:100%; height:38px; padding:0 12px; border:1px solid var(--border); border-radius:8px; background:var(--panel); color:var(--text); margin-bottom:14px; }",
  ".side-runs { border-top:1px solid var(--border); }",
  ".run-row { width:100%; text-align:left; padding:8px 18px; border:0; border-bottom:1px solid var(--border); background:transparent; color:var(--text); cursor:pointer; display:flex; justify-content:space-between; gap:8px; }",
  ".run-row:hover { background:var(--card); } .run-row.active { background:var(--card); box-shadow:inset 2px 0 0 var(--primary); }",
  ".run-row .mono { font-family:ui-monospace,monospace; font-size:11px; }",
].join("\n");

function statusClass(status: string | undefined) {
  if (status === "running" || status === "continued" || (status ?? "").startsWith("waiting")) return "running";
  if (status === "finished") return "finished";
  if (status === "failed" || status === "cancelled") return "failed";
  return "";
}

// Detail pane for the latest worker turn — its own component so the node-output
// hook count stays constant as turns accumulate.
function WorkerPane(props: { runId: string | undefined; index: number | null }) {
  const out = useGatewayNodeOutput({
    runId: props.runId,
    nodeId: props.index === null ? undefined : `worker:${props.index}`,
    iteration: 0,
  });
  const work = useMemo(() => extractWork(out.data), [out.data]);

  return (
    <>
      <div className="col-head">Living spec {work ? <span>turn {(props.index ?? 0) + 1}</span> : null}</div>
      <div className="artifact" data-testid="ug-artifact">
        {work && work.artifact ? (
          <Markdown text={work.artifact} />
        ) : (
          <div className="empty" style={{ margin: "24px auto" }}>The living spec will appear here as the worker updates it.</div>
        )}
      </div>
      <div className="questions">
        <h2>Question pool</h2>
        {work && work.questions.length > 0 ? (
          <ul style={{ listStyle: "none", margin: 0, padding: 0 }} data-testid="ug-questions">
            {work.questions.map((q, i) => (
              <li key={i} className="qcard" data-testid="ug-question">
                <span className="qmark">?</span>
                <span className="q">{q}</span>
              </li>
            ))}
          </ul>
        ) : (
          <div className="muted" style={{ color: "var(--muted)" }}>No open questions yet — say what you want built.</div>
        )}
      </div>
    </>
  );
}

function App() {
  const [selectedRunId, setSelectedRunId] = useState<string | undefined>(runIdFromUrl());
  const [goal, setGoal] = useState("Collaborate on a UI in real time");
  const [draft, setDraft] = useState("");
  const [sent, setSent] = useState<Array<{ seq: number; text: string }>>([]);
  const [busy, setBusy] = useState(false);

  const runsQuery = useGatewayRuns({ filter: { limit: 20 } });
  const actions = useGatewayActions();

  const runs = useMemo(
    () => ((runsQuery.data ?? []) as RunSummary[]).filter((r) => !r.workflowKey || r.workflowKey === WORKFLOW_KEY),
    [runsQuery.data],
  );
  const activeRunId = selectedRunId ?? runIdFromUrl() ?? runs[0]?.runId;
  const activeRun = runs.find((r) => r.runId === activeRunId);
  const runDetail = useGatewayRun(activeRunId);
  const stream = useGatewayRunEvents(activeRunId, { afterSeq: 0 });
  const events = stream.events ?? [];

  // The run-completed frame in the event stream is the authoritative terminal
  // status (runDetail is fetched once and won't otherwise reflect the ending).
  const terminalStatus = useMemo(() => {
    const empty: Record<string, unknown> = {};
    for (const ev of events) {
      const frame = isRecord(ev) ? ev : empty;
      const inner = isRecord(frame.payload) ? frame.payload : empty;
      if (inner.event === "run.completed") {
        const p = isRecord(inner.payload) ? inner.payload : empty;
        return asString(p.status) ?? "finished";
      }
    }
    return undefined;
  }, [events]);
  const runStatus = terminalStatus ?? (runDetail.data as RunSummary | undefined)?.status ?? activeRun?.status;
  const hasRun = Boolean(activeRunId);

  // Worker activity from the event stream.
  const workerActivity = useMemo(() => {
    return events
      .map(eventInfo)
      .filter((e) => workerIndex(e.nodeId) !== null && classify(e.type))
      .map((e) => ({ seq: e.seq, idx: workerIndex(e.nodeId)!, state: classify(e.type) }));
  }, [events]);
  const latestWorkerIdx = workerActivity.length ? Math.max(...workerActivity.map((w) => w.idx)) : null;
  // Worker output is fetched on a one-shot RPC; remount the pane whenever another
  // worker turn finishes so it re-reads the freshly-produced node output.
  const workerDoneCount = useMemo(
    () => new Set(workerActivity.filter((w) => w.state === "done").map((w) => w.idx)).size,
    [workerActivity],
  );

  // Interleave the user's sent messages with worker activity, ordered by seq.
  const feed = useMemo(() => {
    const userRows = sent.map((m) => ({ kind: "me" as const, seq: m.seq, text: m.text }));
    const actRows = workerActivity.map((w) => ({ kind: "act" as const, seq: w.seq, idx: w.idx, state: w.state }));
    return [...userRows, ...actRows].sort((a, b) => a.seq - b.seq);
  }, [sent, workerActivity]);

  async function refresh() {
    await Promise.all([runsQuery.refetch(), runDetail.refetch()]);
  }
  async function launch() {
    setBusy(true);
    try {
      const run = await actions.launchRun({ workflow: WORKFLOW_KEY, input: { goal } });
      setSelectedRunId(run.runId);
      setSent([]);
      await refresh();
    } finally {
      setBusy(false);
    }
  }
  async function send() {
    const text = draft.trim();
    if (!text || !activeRunId) return;
    setBusy(true);
    try {
      await actions.submitSignal({ runId: activeRunId, signalName: "utterance", correlationKey: "utterance", payload: { text, end: false } });
      setSent((s) => [...s, { seq: Date.now(), text }]);
      setDraft("");
    } finally {
      setBusy(false);
    }
  }
  async function end() {
    if (!activeRunId) return;
    setBusy(true);
    try {
      await actions.submitSignal({ runId: activeRunId, signalName: "utterance", correlationKey: "utterance", payload: { text: "", end: true } });
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="shell" data-testid="ultragrill-ui">
      <style>{styles}</style>
      <header className="topbar">
        <div className="title-group">
          <h1>UltraGrill</h1>
          <span className="pill"><span className="mono">{hasRun ? shortRunId(activeRunId) : "no session"}</span></span>
          {hasRun ? <span className={"badge " + statusClass(runStatus)} data-testid="ug-status">{runStatus ?? "idle"}</span> : null}
          {hasRun ? <span className="pill">{events.length} events</span> : null}
        </div>
        <div className="toolbar">
          <button className="button" data-testid="ug-refresh" onClick={() => void refresh()} disabled={busy}>Refresh</button>
          {hasRun && statusClass(runStatus) === "running" ? (
            <button className="button danger" data-testid="ug-end" onClick={() => void end()} disabled={busy}>End session</button>
          ) : null}
        </div>
      </header>

      {!hasRun ? (
        <div className="launch-form" data-testid="ug-empty">
          <h2>Start a collaboration session</h2>
          <p>Say what you want built. A worker carries out each directive, keeps a living spec in sync, and asks clarifying questions you can answer or ignore. The session runs until you end it.</p>
          <input value={goal} onChange={(e) => setGoal(e.currentTarget.value)} placeholder="Session goal" data-testid="ug-goal" />
          <button className="button primary" data-testid="ug-launch" onClick={() => void launch()} disabled={busy}>Start session</button>
          {runs.length > 0 ? (
            <div className="side-runs" style={{ marginTop: 18 }}>
              {runs.map((r) => (
                <button key={r.runId} className="run-row" onClick={() => setSelectedRunId(r.runId)}>
                  <span className="mono">{shortRunId(r.runId)}</span>
                  <span className={"badge " + statusClass(r.status)}>{r.status ?? "?"}</span>
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : (
        <div className="main">
          {/* ── conversation + composer ─────────────────────────────── */}
          <div className="col left">
            <div className="col-head">Conversation <span>{sent.length} sent</span></div>
            <div className="feed" data-testid="ug-feed">
              {feed.length === 0 ? (
                <div className="activity">Say what you want built to begin.</div>
              ) : (
                feed.map((row, i) =>
                  row.kind === "me" ? (
                    <div key={i} className="msg me" data-testid="ug-feed-me">
                      <div className="who">you</div>
                      <div>{row.text}</div>
                    </div>
                  ) : (
                    <div key={i} className="activity" data-testid="ug-feed-worker">
                      <span className="mono">worker:{row.idx}</span>
                      <span className={"ev " + row.state}>{row.state === "done" ? "finished turn" : row.state === "active" ? "working…" : "failed"}</span>
                    </div>
                  ),
                )
              )}
            </div>
            <div className="composer">
              <textarea
                value={draft}
                data-testid="ug-composer"
                placeholder="Tell the worker what to do… (text now; voice is a follow-on)"
                onChange={(e) => setDraft(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void send(); }
                }}
              />
              <button className="button primary" data-testid="ug-send" onClick={() => void send()} disabled={busy || !draft.trim()}>Send</button>
            </div>
          </div>

          {/* ── living spec + question pool ─────────────────────────── */}
          <div className="col right">
            <WorkerPane key={`${latestWorkerIdx}-${workerDoneCount}`} runId={activeRunId} index={latestWorkerIdx} />
          </div>
        </div>
      )}
    </main>
  );
}

createGatewayReactRoot(<App />);
