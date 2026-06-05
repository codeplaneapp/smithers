/** @jsxImportSource react */
import { useMemo, useState } from "react";
import {
  createGatewayReactRoot,
  useGatewayActions,
  useGatewayNodeOutput,
  useGatewayRunEvents,
  useGatewayRuns,
} from "smithers-orchestrator/gateway-react";

const WORKFLOW_KEY = "write-a-prd";

type RunSummary = { runId: string; workflowKey?: string; status?: string; createdAtMs?: number };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}
function shortRunId(runId: string | undefined) {
  return runId ? runId.slice(0, 8) : "--";
}
function runIdFromUrl(): string | undefined {
  if (typeof location === "undefined") return undefined;
  return new URLSearchParams(location.search).get("runId") ?? undefined;
}
function rowOf(value: unknown): Record<string, unknown> {
  const response = isRecord(value) ? value : {};
  return isRecord(response.row) ? response.row : isRecord(response) ? response : {};
}

type GrillState = {
  question: string | null;
  recommendedAnswer: string | null;
  branch: string | null;
  resolved: boolean;
  questionsAsked: number;
  sharedUnderstanding: string | null;
};
function extractGrill(value: unknown): GrillState | null {
  const row = rowOf(value);
  const question = asString(row.question) ?? null;
  const resolved = row.resolved === true;
  const questionsAsked = typeof row.questionsAsked === "number" ? row.questionsAsked : 0;
  const sharedUnderstanding = asString(row.sharedUnderstanding) ?? null;
  if (question === null && !resolved && sharedUnderstanding === null && questionsAsked === 0) return null;
  return {
    question,
    recommendedAnswer: asString(row.recommendedAnswer) ?? null,
    branch: asString(row.branch) ?? null,
    resolved,
    questionsAsked,
    sharedUnderstanding,
  };
}

type UserStory = { actor: string; feature: string; benefit: string };
type PrdModule = { name: string; description: string; isDeepModule: boolean; needsTests: boolean };
type Prd = {
  title: string;
  problemStatement: string;
  solution: string;
  userStories: UserStory[];
  implementationDecisions: string[];
  testingDecisions: string[];
  observabilityRequirements: string[];
  metrics: string[];
  verificationStrategy: string[];
  modules: PrdModule[];
  outOfScope: string[];
  furtherNotes: string | null;
  markdownBody: string;
};
function extractPrd(value: unknown): Prd | null {
  const row = rowOf(value);
  const title = asString(row.title);
  if (title === undefined) return null;
  const stories = Array.isArray(row.userStories) ? row.userStories : [];
  const userStories: UserStory[] = stories
    .filter(isRecord)
    .map((s) => ({ actor: asString(s.actor) ?? "", feature: asString(s.feature) ?? "", benefit: asString(s.benefit) ?? "" }));
  const mods = Array.isArray(row.modules) ? row.modules : [];
  const modules: PrdModule[] = mods.filter(isRecord).map((m) => ({
    name: asString(m.name) ?? "",
    description: asString(m.description) ?? "",
    isDeepModule: m.isDeepModule === true,
    needsTests: m.needsTests === true,
  }));
  return {
    title,
    problemStatement: asString(row.problemStatement) ?? "",
    solution: asString(row.solution) ?? "",
    userStories,
    implementationDecisions: asStringArray(row.implementationDecisions),
    testingDecisions: asStringArray(row.testingDecisions),
    observabilityRequirements: asStringArray(row.observabilityRequirements),
    metrics: asStringArray(row.metrics),
    verificationStrategy: asStringArray(row.verificationStrategy),
    modules,
    outOfScope: asStringArray(row.outOfScope),
    furtherNotes: asString(row.furtherNotes) ?? null,
    markdownBody: asString(row.markdownBody) ?? "",
  };
}

const styles = [
  ":root { --bg:#0c0c0e; --panel:#151518; --card:#1c1c1f; --text:#eee; --muted:#8a8a8e; --border:#262629; --primary:#5e6ad2; --ok:#4ade80; --err:#f87171; --warn:#fbbf24; color-scheme:dark; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif; }",
  "* { box-sizing:border-box; }",
  "body { margin:0; background:var(--bg); color:var(--text); font-size:13px; line-height:1.5; }",
  "button,input,textarea { font:inherit; }",
  ".shell { height:100vh; display:flex; flex-direction:column; overflow:hidden; }",
  ".topbar { display:flex; align-items:center; justify-content:space-between; gap:16px; padding:12px 20px; border-bottom:1px solid var(--border); }",
  ".title-group { display:flex; align-items:center; gap:12px; min-width:0; }",
  "h1 { margin:0; font-size:14px; font-weight:600; }",
  ".pill { display:inline-flex; align-items:center; gap:6px; font-size:12px; color:var(--muted); background:var(--panel); padding:4px 10px; border-radius:6px; border:1px solid var(--border); }",
  ".toolbar { display:flex; align-items:center; gap:8px; }",
  ".button { height:30px; padding:0 12px; border:1px solid var(--border); border-radius:6px; background:var(--panel); color:var(--text); cursor:pointer; font-weight:500; }",
  ".button:hover { background:var(--card); }",
  ".button.primary { background:var(--primary); color:#fff; border-color:var(--primary); }",
  ".button.danger { color:var(--err); }",
  ".button:disabled { opacity:0.4; cursor:not-allowed; }",
  ".badge { font-size:11px; font-weight:600; text-transform:uppercase; padding:3px 8px; border-radius:5px; border:1px solid var(--border); }",
  ".badge.running { color:var(--warn); border-color:var(--warn); }",
  ".badge.finished { color:var(--ok); border-color:var(--ok); }",
  ".badge.failed { color:var(--err); border-color:var(--err); }",
  ".main { display:grid; grid-template-columns:3fr 2fr; flex:1; overflow:hidden; }",
  ".left-col { display:flex; flex-direction:column; overflow:hidden; border-right:1px solid var(--border); }",
  ".section-head { padding:10px 18px; font-size:11px; text-transform:uppercase; letter-spacing:0.04em; color:var(--muted); border-bottom:1px solid var(--border); display:flex; align-items:center; justify-content:space-between; }",
  ".qa-pane { padding:18px; overflow:auto; flex:0 0 auto; max-height:55%; border-bottom:1px solid var(--border); }",
  ".question-card { background:var(--card); border:1px solid var(--border); border-radius:10px; padding:18px 20px; }",
  ".question-meta { display:flex; gap:8px; align-items:center; margin-bottom:10px; flex-wrap:wrap; }",
  ".tag { font-size:11px; color:var(--muted); background:var(--panel); border:1px solid var(--border); border-radius:5px; padding:2px 8px; }",
  ".question-text { font-size:16px; line-height:1.5; margin-bottom:14px; }",
  ".recommend { background:var(--panel); border:1px solid var(--border); border-left:3px solid var(--primary); border-radius:6px; padding:10px 12px; margin-bottom:14px; }",
  ".recommend .lbl { font-size:11px; text-transform:uppercase; letter-spacing:0.04em; color:var(--primary); margin-bottom:4px; }",
  ".answer-box { width:100%; min-height:64px; resize:vertical; padding:10px; border:1px solid var(--border); border-radius:6px; background:var(--bg); color:var(--text); margin-bottom:10px; }",
  ".answer-row { display:flex; gap:8px; }",
  ".shared { margin-top:14px; padding:12px 14px; background:var(--panel); border:1px solid var(--border); border-radius:8px; }",
  ".shared .lbl { font-size:11px; text-transform:uppercase; letter-spacing:0.04em; color:var(--muted); margin-bottom:6px; }",
  ".history-pane { padding:14px 18px; overflow:auto; flex:1; }",
  ".history-item { display:flex; gap:10px; padding:8px 0; border-bottom:1px solid var(--border); }",
  ".history-item:last-child { border-bottom:0; }",
  ".dot { flex:0 0 8px; height:8px; border-radius:50%; background:var(--primary); margin-top:6px; }",
  ".dot.resolved { background:var(--ok); }",
  ".prd-pane { overflow:auto; padding:18px; }",
  ".prd-title { font-size:18px; font-weight:600; margin:0 0 4px; }",
  ".prd-section { margin-top:18px; }",
  ".prd-section h3 { font-size:12px; text-transform:uppercase; letter-spacing:0.04em; color:var(--muted); margin:0 0 8px; }",
  ".prd-section p { margin:0; }",
  ".prd-list { margin:0; padding-left:18px; }",
  ".prd-list li { margin-bottom:4px; }",
  ".story { padding:8px 0; border-bottom:1px solid var(--border); }",
  ".story:last-child { border-bottom:0; }",
  ".story b { color:var(--primary); }",
  ".module-card { background:var(--card); border:1px solid var(--border); border-radius:8px; padding:10px 12px; margin-bottom:8px; }",
  ".module-card .mhead { display:flex; gap:8px; align-items:center; margin-bottom:4px; }",
  ".chip { font-size:10px; text-transform:uppercase; letter-spacing:0.03em; padding:2px 6px; border-radius:4px; border:1px solid var(--border); color:var(--muted); }",
  ".chip.deep { color:var(--ok); border-color:var(--ok); }",
  ".chip.tests { color:var(--warn); border-color:var(--warn); }",
  ".empty { color:var(--muted); text-align:center; padding:40px 16px; }",
  ".empty .button { margin-top:14px; }",
  ".launch-form { max-width:520px; margin:48px auto; padding:24px; background:var(--card); border:1px solid var(--border); border-radius:12px; }",
  ".launch-form h2 { margin:0 0 6px; font-size:16px; }",
  ".launch-form p { margin:0 0 16px; color:var(--muted); }",
  ".launch-form textarea { width:100%; min-height:96px; resize:vertical; padding:10px; border:1px solid var(--border); border-radius:6px; background:var(--bg); color:var(--text); margin-bottom:14px; }",
  ".slider-row { display:flex; align-items:center; gap:10px; margin-bottom:18px; color:var(--muted); }",
  ".slider-row input { flex:1; }",
  ".sidebar { border-left:1px solid var(--border); background:var(--panel); overflow:auto; }",
  ".side-head { padding:12px 16px; font-size:11px; text-transform:uppercase; letter-spacing:0.04em; color:var(--muted); border-bottom:1px solid var(--border); }",
  ".run-row { width:100%; text-align:left; padding:10px 16px; border:0; border-bottom:1px solid var(--border); background:transparent; color:var(--text); cursor:pointer; display:flex; justify-content:space-between; gap:8px; }",
  ".run-row:hover { background:var(--card); }",
  ".run-row.active { background:var(--card); box-shadow:inset 2px 0 0 var(--primary); }",
  ".run-row .mono { font-family:ui-monospace,monospace; font-size:11px; }",
  ".footer { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:10px 20px; border-top:1px solid var(--border); background:var(--panel); color:var(--muted); }",
].join("\n");

function statusClass(status: string | undefined) {
  if (status === "running" || status === "continued") return "running";
  if (status === "finished") return "finished";
  if (status === "failed" || status === "cancelled") return "failed";
  return "";
}

function ListSection(props: { id: string; title: string; items: string[] }) {
  if (props.items.length === 0) return null;
  return (
    <div className="prd-section" data-testid={props.id}>
      <h3>{props.title}</h3>
      <ul className="prd-list">
        {props.items.map((it, i) => (
          <li key={i}>{it}</li>
        ))}
      </ul>
    </div>
  );
}

function App() {
  const [selectedRunId, setSelectedRunId] = useState<string | undefined>(runIdFromUrl());
  const [prompt, setPrompt] = useState("Build a real-time notifications system.");
  const [maxIterations, setMaxIterations] = useState(10);
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);

  const runsQuery = useGatewayRuns({ filter: { limit: 20 } });
  const actions = useGatewayActions();

  const prdRuns = useMemo(
    () => ((runsQuery.data ?? []) as RunSummary[]).filter((r) => !r.workflowKey || r.workflowKey === WORKFLOW_KEY),
    [runsQuery.data],
  );
  const activeRunId = selectedRunId ?? runIdFromUrl() ?? prdRuns[0]?.runId;
  const activeRun = prdRuns.find((r) => r.runId === activeRunId);
  const stream = useGatewayRunEvents(activeRunId, { afterSeq: 0 });
  const grillOutput = useGatewayNodeOutput({ runId: activeRunId, nodeId: "write-a-prd:grill", iteration: 0 });
  const prdOutput = useGatewayNodeOutput({ runId: activeRunId, nodeId: "write-a-prd:prd", iteration: 0 });

  const grill = useMemo(() => extractGrill(grillOutput.data), [grillOutput.data]);
  const prd = useMemo(() => extractPrd(prdOutput.data), [prdOutput.data]);
  const eventCount = (stream.events ?? []).length;

  async function refresh() {
    await Promise.all([runsQuery.refetch(), grillOutput.refetch(), prdOutput.refetch()]);
  }
  async function launch() {
    setBusy(true);
    try {
      const run = await actions.launchRun({ workflow: WORKFLOW_KEY, input: { prompt, maxIterations } });
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
  async function submitAnswer(text: string) {
    if (!activeRunId || text.trim() === "") return;
    setBusy(true);
    try {
      await actions.submitSignal({
        runId: activeRunId,
        correlationKey: "answer",
        signalName: "answer",
        payload: { answer: text },
      });
      setAnswer("");
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  if (!activeRunId) {
    return (
      <main className="shell" data-testid="write-a-prd-ui">
        <style>{styles}</style>
        <header className="topbar">
          <div className="title-group">
            <h1>Write a PRD</h1>
            <span className="pill" data-testid="write-a-prd-runid">No run</span>
          </div>
        </header>
        <div className="launch-form" data-testid="write-a-prd-launch-form">
          <h2>Start a new PRD</h2>
          <p>Describe the feature or product you want to specify. Claude will grill you until the spec converges.</p>
          <textarea
            data-testid="write-a-prd-prompt"
            value={prompt}
            onChange={(e) => setPrompt(e.currentTarget.value)}
            placeholder="Build a real-time notifications system, or Add dark mode to the dashboard"
          />
          <div className="slider-row">
            <span>Max iterations</span>
            <input
              type="range"
              min={1}
              max={20}
              data-testid="write-a-prd-iterations"
              value={maxIterations}
              onChange={(e) => setMaxIterations(Number(e.currentTarget.value))}
            />
            <span>{maxIterations}</span>
          </div>
          <button className="button primary" data-testid="write-a-prd-launch" onClick={() => void launch()} disabled={busy}>
            Start PRD
          </button>
        </div>
      </main>
    );
  }

  return (
    <main className="shell" data-testid="write-a-prd-ui">
      <style>{styles}</style>
      <header className="topbar">
        <div className="title-group">
          <h1>Write a PRD</h1>
          <span className="pill" data-testid="write-a-prd-runid">{shortRunId(activeRunId)}</span>
          {activeRun ? (
            <span className={"badge " + statusClass(activeRun.status)} data-testid="write-a-prd-status">
              {grill && grill.resolved ? "resolved" : activeRun.status ?? "idle"}
            </span>
          ) : null}
        </div>
        <div className="toolbar">
          <button className="button" data-testid="write-a-prd-refresh" onClick={() => void refresh()} disabled={busy}>
            Refresh
          </button>
          {activeRun && statusClass(activeRun.status) === "running" ? (
            <button className="button danger" data-testid="write-a-prd-cancel" onClick={() => void cancel()} disabled={busy}>
              Cancel
            </button>
          ) : null}
          <button className="button primary" data-testid="write-a-prd-launch" onClick={() => void launch()} disabled={busy}>
            New PRD
          </button>
        </div>
      </header>

      <div className="main">
        <div className="left-col">
          <div className="section-head">
            <span>Q&amp;A Grilling</span>
            {grill ? <span className="tag">{grill.questionsAsked} asked</span> : null}
          </div>
          <div className="qa-pane" data-testid="write-a-prd-qa">
            {grill && grill.question ? (
              <div className="question-card">
                <div className="question-meta">
                  <span className="tag">Question {grill.questionsAsked || 1}</span>
                  {grill.branch ? <span className="tag">{grill.branch}</span> : null}
                </div>
                <div className="question-text">{grill.question}</div>
                {grill.recommendedAnswer ? (
                  <div className="recommend">
                    <div className="lbl">Recommended answer</div>
                    <div>{grill.recommendedAnswer}</div>
                  </div>
                ) : null}
                <textarea
                  className="answer-box"
                  data-testid="write-a-prd-answer"
                  value={answer}
                  onChange={(e) => setAnswer(e.currentTarget.value)}
                  placeholder="Type your answer..."
                />
                <div className="answer-row">
                  <button className="button primary" data-testid="write-a-prd-submit" onClick={() => void submitAnswer(answer)} disabled={busy}>
                    Submit answer
                  </button>
                  {grill.recommendedAnswer ? (
                    <button
                      className="button"
                      data-testid="write-a-prd-accept"
                      onClick={() => void submitAnswer(grill.recommendedAnswer || "")}
                      disabled={busy}
                    >
                      Accept recommended
                    </button>
                  ) : null}
                </div>
              </div>
            ) : grill && grill.resolved ? (
              <div className="empty" data-testid="write-a-prd-qa-resolved">
                Grilling resolved. The PRD has converged.
              </div>
            ) : (
              <div className="empty" data-testid="write-a-prd-qa-empty">
                {activeRun && statusClass(activeRun.status) === "running"
                  ? "Agent is forming the next question..."
                  : "No question pending yet."}
              </div>
            )}
            {grill && grill.sharedUnderstanding ? (
              <div className="shared" data-testid="write-a-prd-shared">
                <div className="lbl">Shared understanding</div>
                <div>{grill.sharedUnderstanding}</div>
              </div>
            ) : null}
          </div>

          <div className="section-head">Iteration history</div>
          <div className="history-pane" data-testid="write-a-prd-history">
            {grill ? (
              <div className="history-item">
                <span className={"dot" + (grill.resolved ? " resolved" : "")} />
                <div>
                  <div>{grill.resolved ? "Converged — marked resolved" : "Grilling in progress"}</div>
                  <div style={{ color: "var(--muted)" }}>{grill.questionsAsked} questions asked</div>
                </div>
              </div>
            ) : (
              <div className="empty">No iterations recorded yet.</div>
            )}
          </div>
        </div>

        <aside className="prd-pane" data-testid="write-a-prd-preview">
          {prd ? (
            <>
              <h2 className="prd-title" data-testid="write-a-prd-doc-title">{prd.title}</h2>
              {prd.problemStatement ? (
                <div className="prd-section" data-testid="write-a-prd-problem">
                  <h3>Problem statement</h3>
                  <p>{prd.problemStatement}</p>
                </div>
              ) : null}
              {prd.solution ? (
                <div className="prd-section" data-testid="write-a-prd-solution">
                  <h3>Solution</h3>
                  <p>{prd.solution}</p>
                </div>
              ) : null}
              {prd.userStories.length > 0 ? (
                <div className="prd-section" data-testid="write-a-prd-stories">
                  <h3>User stories</h3>
                  {prd.userStories.map((s, i) => (
                    <div className="story" key={i}>
                      As a <b>{s.actor}</b>, I want <b>{s.feature}</b>, so that {s.benefit}.
                    </div>
                  ))}
                </div>
              ) : null}
              {prd.modules.length > 0 ? (
                <div className="prd-section" data-testid="write-a-prd-modules">
                  <h3>Modules</h3>
                  {prd.modules.map((m, i) => (
                    <div className="module-card" key={i}>
                      <div className="mhead">
                        <b>{m.name}</b>
                        {m.isDeepModule ? <span className="chip deep">deep</span> : null}
                        {m.needsTests ? <span className="chip tests">tests</span> : null}
                      </div>
                      <div style={{ color: "var(--muted)" }}>{m.description}</div>
                    </div>
                  ))}
                </div>
              ) : null}
              <ListSection id="write-a-prd-impl" title="Implementation decisions" items={prd.implementationDecisions} />
              <ListSection id="write-a-prd-testing" title="Testing decisions" items={prd.testingDecisions} />
              <ListSection id="write-a-prd-observability" title="Observability requirements" items={prd.observabilityRequirements} />
              <ListSection id="write-a-prd-metrics" title="Metrics" items={prd.metrics} />
              <ListSection id="write-a-prd-verification" title="Verification strategy" items={prd.verificationStrategy} />
              <ListSection id="write-a-prd-outofscope" title="Out of scope" items={prd.outOfScope} />
              {prd.furtherNotes ? (
                <div className="prd-section" data-testid="write-a-prd-notes">
                  <h3>Further notes</h3>
                  <p>{prd.furtherNotes}</p>
                </div>
              ) : null}
            </>
          ) : (
            <div className="empty" data-testid="write-a-prd-preview-empty">
              <div>{activeRunId ? "PRD draft will appear here as the grilling resolves." : "No PRD yet."}</div>
              <button className="button primary" data-testid="write-a-prd-launch-empty" onClick={() => void launch()} disabled={busy}>
                New PRD
              </button>
            </div>
          )}
        </aside>
      </div>

      <footer className="footer">
        <span data-testid="write-a-prd-events">{eventCount} events</span>
        <div className="toolbar">
          <span className="side-head" style={{ border: 0, padding: 0 }}>Recent PRDs</span>
          {prdRuns.slice(0, 6).map((r) => (
            <button
              key={r.runId}
              className={"run-row" + (r.runId === activeRunId ? " active" : "")}
              data-testid={"write-a-prd-run-" + r.runId}
              onClick={() => setSelectedRunId(r.runId)}
              style={{ width: "auto", border: "1px solid var(--border)", borderRadius: 6 }}
            >
              <span className="mono">{shortRunId(r.runId)}</span>
              <span className={"badge " + statusClass(r.status)}>{r.status ?? "?"}</span>
            </button>
          ))}
          {prdRuns.length === 0 ? <span style={{ color: "var(--muted)" }}>No runs yet.</span> : null}
        </div>
      </footer>
    </main>
  );
}

createGatewayReactRoot(<App />);
