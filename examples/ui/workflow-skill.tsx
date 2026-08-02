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

const WORKFLOW_KEY = "workflow-skill";

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
function unwrapRow(value: unknown): Record<string, unknown> {
  const response = isRecord(value) ? value : {};
  if (isRecord(response.row)) return response.row;
  return response;
}

type WorkflowSource = {
  id: string;
  displayName: string;
  sourceType: string;
  entryFile: string;
};
type ExistingSkill = { path: string };
type CollectOutput = {
  workflowTarget: string;
  output: string | null;
  outputRule: string;
  defaultSkillDir: string;
  prompt: string;
  workflows: WorkflowSource[];
  existingSkills: ExistingSkill[];
};
function extractCollect(value: unknown): CollectOutput | null {
  const row = unwrapRow(value);
  const workflowTarget = asString(row.workflowTarget);
  if (workflowTarget === undefined) return null;
  const workflows = Array.isArray(row.workflows)
    ? row.workflows
        .filter(isRecord)
        .map((w) => ({
          id: asString(w.id) ?? "",
          displayName: asString(w.displayName) ?? asString(w.id) ?? "",
          sourceType: asString(w.sourceType) ?? "user",
          entryFile: asString(w.entryFile) ?? "",
        }))
    : [];
  const existingSkills = Array.isArray(row.existingSkills)
    ? row.existingSkills
        .filter(isRecord)
        .map((s) => ({ path: asString(s.path) ?? "" }))
    : [];
  return {
    workflowTarget,
    output: asString(row.output) ?? null,
    outputRule: asString(row.outputRule) ?? "",
    defaultSkillDir: asString(row.defaultSkillDir) ?? "",
    prompt: asString(row.prompt) ?? "",
    workflows,
    existingSkills,
  };
}

type WrittenSkill = {
  workflow: string;
  path: string;
  skillName: string;
  action: string;
};
type WriteResult = { summary: string; written: WrittenSkill[] };
function extractWriteResult(value: unknown): WriteResult | null {
  const row = unwrapRow(value);
  const summary = asString(row.summary);
  if (summary === undefined) return null;
  const written = Array.isArray(row.written)
    ? row.written
        .filter(isRecord)
        .map((w) => ({
          workflow: asString(w.workflow) ?? "",
          path: asString(w.path) ?? "",
          skillName: asString(w.skillName) ?? "",
          action: asString(w.action) ?? "updated",
        }))
    : [];
  return { summary, written };
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
  ".prompt { flex:1; max-width:360px; height:30px; padding:0 10px; border:1px solid var(--border); border-radius:6px; background:var(--panel); color:var(--text); }",
  ".target { width:120px; height:30px; padding:0 10px; border:1px solid var(--border); border-radius:6px; background:var(--panel); color:var(--text); }",
  ".button { height:30px; padding:0 12px; border:1px solid var(--border); border-radius:6px; background:var(--panel); color:var(--text); cursor:pointer; font-weight:500; }",
  ".button:hover { background:var(--card); }",
  ".button.primary { background:var(--primary); color:#fff; border-color:var(--primary); }",
  ".button.danger { color:var(--err); }",
  ".button:disabled { opacity:0.4; cursor:not-allowed; }",
  ".main { display:grid; grid-template-columns:240px 1fr; flex:1; overflow:hidden; }",
  ".sidebar { border-right:1px solid var(--border); background:var(--panel); overflow:auto; }",
  ".side-head { padding:12px 16px; font-size:11px; text-transform:uppercase; letter-spacing:0.04em; color:var(--muted); border-bottom:1px solid var(--border); }",
  ".run-row { width:100%; text-align:left; padding:10px 16px; border:0; border-bottom:1px solid var(--border); background:transparent; color:var(--text); cursor:pointer; display:flex; justify-content:space-between; gap:8px; align-items:center; }",
  ".run-row:hover { background:var(--card); }",
  ".run-row.active { background:var(--card); box-shadow:inset 2px 0 0 var(--primary); }",
  ".run-row .mono { font-family:ui-monospace,monospace; font-size:11px; }",
  ".content { padding:20px; overflow:auto; }",
  ".badge { font-size:11px; font-weight:600; text-transform:uppercase; padding:3px 8px; border-radius:5px; border:1px solid var(--border); }",
  ".badge.running { color:var(--warn); border-color:var(--warn); }",
  ".badge.finished { color:var(--ok); border-color:var(--ok); }",
  ".badge.failed { color:var(--err); border-color:var(--err); }",
  ".inputbar { display:flex; flex-wrap:wrap; gap:10px; background:var(--card); border:1px solid var(--border); border-radius:10px; padding:14px 18px; margin-bottom:18px; }",
  ".inputbar .field { display:flex; flex-direction:column; gap:3px; }",
  ".inputbar .label { font-size:10px; text-transform:uppercase; letter-spacing:0.04em; color:var(--muted); }",
  ".inputbar .value { font-size:13px; font-family:ui-monospace,monospace; }",
  ".timeline { display:flex; align-items:stretch; gap:0; margin-bottom:18px; }",
  ".tl-node { flex:1; background:var(--card); border:1px solid var(--border); border-radius:10px; padding:14px 16px; display:flex; flex-direction:column; gap:6px; }",
  ".tl-conn { display:flex; align-items:center; padding:0 10px; color:var(--muted); }",
  ".tl-name { font-size:13px; font-weight:600; display:flex; align-items:center; gap:8px; }",
  ".tl-sub { font-size:11px; color:var(--muted); }",
  ".dot { width:9px; height:9px; border-radius:50%; background:var(--border); display:inline-block; }",
  ".dot.running { background:var(--warn); }",
  ".dot.done { background:var(--ok); }",
  ".dot.failed { background:var(--err); }",
  ".section { background:var(--card); border:1px solid var(--border); border-radius:10px; padding:16px 18px; margin-bottom:18px; }",
  ".section h2 { margin:0 0 10px; font-size:12px; text-transform:uppercase; letter-spacing:0.04em; color:var(--muted); }",
  ".section .summary-text { font-size:15px; line-height:1.55; margin-bottom:12px; }",
  ".collapse-head { cursor:pointer; user-select:none; display:flex; align-items:center; gap:8px; }",
  ".list { list-style:none; margin:0; padding:0; }",
  ".list li { display:flex; justify-content:space-between; gap:12px; padding:8px 0; border-bottom:1px solid var(--border); }",
  ".list li:last-child { border-bottom:0; }",
  ".list .mono { font-family:ui-monospace,monospace; font-size:12px; color:var(--muted); }",
  ".list .name { font-weight:500; }",
  ".action-badge { font-size:10px; font-weight:600; text-transform:uppercase; padding:2px 7px; border-radius:4px; border:1px solid var(--border); }",
  ".action-badge.created { color:var(--ok); border-color:var(--ok); }",
  ".action-badge.updated { color:var(--warn); border-color:var(--warn); }",
  ".count { font-size:11px; color:var(--muted); margin-left:auto; }",
  ".empty { color:var(--muted); text-align:center; padding:48px 16px; }",
  ".empty .button { margin-top:14px; }",
  ".empty-inline { color:var(--muted); padding:10px 0; font-size:12px; }",
  ".footer { display:flex; align-items:center; gap:10px; color:var(--muted); font-size:12px; margin-top:8px; }",
].join("\n");

function statusClass(status: string | undefined) {
  if (status === "running" || status === "continued") return "running";
  if (status === "finished") return "finished";
  if (status === "failed" || status === "cancelled") return "failed";
  return "";
}

function nodeState(
  finished: boolean,
  active: boolean,
  done: boolean,
  failed: boolean,
) {
  if (done) return "done";
  if (failed) return "failed";
  if (active && !finished) return "running";
  return "pending";
}

function App() {
  const [selectedRunId, setSelectedRunId] = useState<string | undefined>(runIdFromUrl());
  const [workflow, setWorkflow] = useState("all");
  const [prompt, setPrompt] = useState("");
  const [collectOpen, setCollectOpen] = useState(true);
  const [busy, setBusy] = useState(false);

  const runsQuery = useGatewayRuns({ filter: { limit: 20 } });
  const actions = useGatewayActions();

  const skillRuns = useMemo(
    () =>
      ((runsQuery.data ?? []) as RunSummary[]).filter(
        (r) => !r.workflowKey || r.workflowKey === WORKFLOW_KEY,
      ),
    [runsQuery.data],
  );
  const activeRunId = selectedRunId ?? runIdFromUrl() ?? skillRuns[0]?.runId;
  const activeRun = skillRuns.find((r) => r.runId === activeRunId);

  const stream = useGatewayRunEvents(activeRunId, { afterSeq: 0 });
  const collectQuery = useGatewayNodeOutput({ runId: activeRunId, nodeId: "collect", iteration: 0 });
  const writeQuery = useGatewayNodeOutput({ runId: activeRunId, nodeId: "write-skills", iteration: 0 });

  const collect = useMemo(() => extractCollect(collectQuery.data), [collectQuery.data]);
  const result = useMemo(() => extractWriteResult(writeQuery.data), [writeQuery.data]);

  const events = stream.events ?? [];
  const runStatus = statusClass(activeRun?.status);
  const runFailed = runStatus === "failed";
  const collectDone = collect !== null;
  const writeDone = result !== null;

  const createdCount = result ? result.written.filter((w) => w.action === "created").length : 0;
  const updatedCount = result ? result.written.filter((w) => w.action === "updated").length : 0;
  const successCount = skillRuns.filter((r) => statusClass(r.status) === "finished").length;

  async function refresh() {
    await Promise.all([
      runsQuery.refetch(),
      collectQuery.refetch(),
      writeQuery.refetch(),
    ]);
  }
  async function launch() {
    setBusy(true);
    try {
      const input: Record<string, unknown> = { workflow: workflow.trim() || "all" };
      if (prompt.trim()) input.prompt = prompt.trim();
      const run = await actions.launchRun({ workflow: WORKFLOW_KEY, input });
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
  async function resume() {
    if (!activeRunId) return;
    setBusy(true);
    try {
      await actions.resumeRun({ runId: activeRunId });
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="shell" data-testid="workflow-skill-ui">
      <style>{styles}</style>
      <WorkflowUiStyles mode="theme" />
      <header className="topbar">
        <div className="title-group">
          <h1>Workflow Skill</h1>
          <span className="pill" data-testid="workflow-skill-runid">
            {activeRunId ? shortRunId(activeRunId) : "No run"}
          </span>
          {activeRun ? (
            <span className={"badge " + runStatus} data-testid="workflow-skill-status">
              {activeRun.status ?? "idle"}
            </span>
          ) : null}
        </div>
        <div className="toolbar">
          <input
            className="target"
            data-testid="workflow-skill-target"
            value={workflow}
            onChange={(e) => setWorkflow(e.currentTarget.value)}
            placeholder="workflow (all)"
          />
          <input
            className="prompt"
            data-testid="workflow-skill-prompt"
            value={prompt}
            onChange={(e) => setPrompt(e.currentTarget.value)}
            placeholder="Extra instructions (optional)"
          />
          <button
            className="button"
            data-testid="workflow-skill-refresh"
            onClick={() => void refresh()}
            disabled={busy}
          >
            Refresh
          </button>
          {runStatus === "running" ? (
            <button
              className="button danger"
              data-testid="workflow-skill-cancel"
              onClick={() => void cancel()}
              disabled={busy}
            >
              Cancel
            </button>
          ) : null}
          {runFailed ? (
            <button
              className="button"
              data-testid="workflow-skill-resume"
              onClick={() => void resume()}
              disabled={busy}
            >
              Resume
            </button>
          ) : null}
          <button
            className="button primary"
            data-testid="workflow-skill-launch"
            onClick={() => void launch()}
            disabled={busy}
          >
            Generate Skills
          </button>
        </div>
      </header>

      <div className="main">
        <aside className="sidebar">
          <div className="side-head">Recent runs</div>
          {skillRuns.map((r) => (
            <button
              key={r.runId}
              className={"run-row" + (r.runId === activeRunId ? " active" : "")}
              data-testid={"workflow-skill-run-" + r.runId}
              onClick={() => setSelectedRunId(r.runId)}
            >
              <span className="mono">{shortRunId(r.runId)}</span>
              <span className={"badge " + statusClass(r.status)}>{r.status ?? "?"}</span>
            </button>
          ))}
          {skillRuns.length === 0 ? <div className="empty">No runs yet.</div> : null}
        </aside>

        <div className="content">
          {activeRunId ? (
            <>
              <div className="inputbar" data-testid="workflow-skill-input">
                <div className="field">
                  <span className="label">Workflow target</span>
                  <span className="value">{collect?.workflowTarget ?? workflow ?? "all"}</span>
                </div>
                <div className="field">
                  <span className="label">Output</span>
                  <span className="value">{collect?.output ?? collect?.defaultSkillDir ?? "default"}</span>
                </div>
                <div className="field">
                  <span className="label">Extra prompt</span>
                  <span className="value">{collect?.prompt && collect.prompt.length > 0 ? collect.prompt : "none"}</span>
                </div>
              </div>

              <div className="timeline" data-testid="workflow-skill-timeline">
                <div className="tl-node">
                  <div className="tl-name">
                    <span className={"dot " + nodeState(collectDone, true, collectDone, runFailed && !collectDone)} />
                    collect
                  </div>
                  <div className="tl-sub">
                    {collect
                      ? collect.workflows.length + " workflows discovered"
                      : "discovering workflows"}
                  </div>
                </div>
                <div className="tl-conn">→</div>
                <div className="tl-node">
                  <div className="tl-name">
                    <span className={"dot " + nodeState(writeDone, collectDone, writeDone, runFailed && collectDone)} />
                    write-skills
                  </div>
                  <div className="tl-sub">
                    {result
                      ? result.written.length + " skills written"
                      : collectDone
                        ? "writing skill docs"
                        : "waiting on collect"}
                  </div>
                </div>
              </div>

              <div className="section" data-testid="workflow-skill-collect">
                <div className="collapse-head" onClick={() => setCollectOpen((v) => !v)}>
                  <h2 style={{ margin: 0 }}>Collection details</h2>
                  <span className="count">{collectOpen ? "hide" : "show"}</span>
                </div>
                {collectOpen ? (
                  collect ? (
                    <div style={{ marginTop: 12 }}>
                      <div className="label" style={{ marginBottom: 6 }}>
                        Workflows to document
                      </div>
                      <ul className="list" data-testid="workflow-skill-workflows">
                        {collect.workflows.map((w) => (
                          <li key={w.id}>
                            <span className="name">{w.displayName}</span>
                            <span className="mono">{w.id}</span>
                          </li>
                        ))}
                        {collect.workflows.length === 0 ? (
                          <li className="empty-inline">No workflows discovered.</li>
                        ) : null}
                      </ul>
                      <div className="label" style={{ margin: "14px 0 6px" }}>
                        Existing skills on disk
                      </div>
                      <ul className="list" data-testid="workflow-skill-existing">
                        {collect.existingSkills.map((s) => (
                          <li key={s.path}>
                            <span className="mono">{s.path}</span>
                          </li>
                        ))}
                        {collect.existingSkills.length === 0 ? (
                          <li className="empty-inline">No existing skill files yet.</li>
                        ) : null}
                      </ul>
                    </div>
                  ) : (
                    <div className="empty-inline" data-testid="workflow-skill-collect-pending">
                      Waiting for the collect task to finish discovery…
                    </div>
                  )
                ) : null}
              </div>

              <div className="section" data-testid="workflow-skill-results">
                <div className="collapse-head">
                  <h2 style={{ margin: 0 }}>Generated skills</h2>
                  {result ? (
                    <span className="count">
                      {createdCount} created · {updatedCount} updated
                    </span>
                  ) : null}
                </div>
                {result ? (
                  <div style={{ marginTop: 12 }}>
                    <div className="summary-text" data-testid="workflow-skill-summary">
                      {result.summary}
                    </div>
                    <ul className="list" data-testid="workflow-skill-written">
                      {result.written.map((w, i) => (
                        <li key={w.path + ":" + i}>
                          <span className="name">{w.skillName || w.workflow}</span>
                          <span className="mono">{w.path}</span>
                          <span className={"action-badge " + w.action}>{w.action}</span>
                        </li>
                      ))}
                      {result.written.length === 0 ? (
                        <li className="empty-inline" data-testid="workflow-skill-written-empty">
                          No skill files were written in this run.
                        </li>
                      ) : null}
                    </ul>
                  </div>
                ) : (
                  <div className="empty-inline" data-testid="workflow-skill-results-pending">
                    {collectDone
                      ? "Generating skill documentation…"
                      : "Results appear once write-skills completes."}
                  </div>
                )}
              </div>

              <div className="footer">
                <span>{events.length} events</span>
                <span>·</span>
                <span>
                  {successCount} of {skillRuns.length} runs successful
                </span>
                {collectQuery.loading || writeQuery.loading ? <span>· refreshing…</span> : null}
              </div>
            </>
          ) : (
            <div className="empty" data-testid="workflow-skill-empty">
              <div>
                Select a run from the sidebar, or launch a new one to generate skill documentation.
                No run selected.
              </div>
              <button
                className="button primary"
                data-testid="workflow-skill-launch-empty"
                onClick={() => void launch()}
                disabled={busy}
              >
                Generate Skills
              </button>
            </div>
          )}
        </div>
      </div>
    </main>
  );
}

createGatewayReactRoot(<App />);
