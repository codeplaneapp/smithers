/** @jsxImportSource react */
import { useMemo, useState } from "react";
import {
  createGatewayReactRoot,
  useGatewayActions,
  useGatewayApprovals,
  useGatewayNodeOutput,
  useGatewayRun,
  useGatewayRunEvents,
  useGatewayRuns,
} from "smithers-orchestrator/gateway-react";

const WORKFLOW_KEY = "mission";
const MAX_MILESTONES = 6;

type RunSummary = { runId: string; workflowKey?: string; status?: string; createdAtMs?: number };
type ApprovalSummary = {
  runId: string;
  nodeId: string;
  iteration: number;
  requestTitle?: string;
  requestSummary?: string;
};

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

// Every node output is delivered under value.data.row; this UI receives value already
// being the hook's .data, so unwrap a possible .row wrapper here.
function unwrapRow(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  if (isRecord(value.row)) return value.row;
  return value;
}

type Milestone = { id: string; title: string; objective: string; featureCount: number };
type MissionPlan = {
  goal: string;
  summary: string;
  milestones: Milestone[];
  assumptions: string[];
  risks: string[];
  outOfScope: string[];
};
function extractPlan(value: unknown): MissionPlan | null {
  const row = unwrapRow(value);
  if (!row) return null;
  const summary = asString(row.summary);
  if (summary === undefined) return null;
  const milestones = asArray(row.milestones).map((m, i) => {
    const rec = isRecord(m) ? m : {};
    return {
      id: asString(rec.id) ?? "milestone-" + (i + 1),
      title: asString(rec.title) ?? "Milestone " + (i + 1),
      objective: asString(rec.objective) ?? "",
      featureCount: asArray(rec.features).length,
    };
  });
  return {
    goal: asString(row.goal) ?? "",
    summary,
    milestones,
    assumptions: asStringArray(row.assumptions),
    risks: asStringArray(row.risks),
    outOfScope: asStringArray(row.outOfScope),
  };
}

type MissionApproval = { approved: boolean; note: string | null; decidedBy: string | null };
function extractApproval(value: unknown): MissionApproval | null {
  const row = unwrapRow(value);
  if (!row || typeof row.approved !== "boolean") return null;
  return {
    approved: row.approved,
    note: asString(row.note) ?? null,
    decidedBy: asString(row.decidedBy) ?? null,
  };
}

type Integration = {
  status: string;
  summary: string;
  mergedBranches: string[];
  conflictedBranches: string[];
  filesChanged: string[];
};
function extractIntegration(value: unknown): Integration | null {
  const row = unwrapRow(value);
  if (!row) return null;
  const summary = asString(row.summary);
  if (summary === undefined) return null;
  return {
    status: asString(row.status) ?? "integrated",
    summary,
    mergedBranches: asStringArray(row.mergedBranches),
    conflictedBranches: asStringArray(row.conflictedBranches),
    filesChanged: asStringArray(row.filesChanged),
  };
}

type ValidationCheck = { name: string; status: string; details: string | null };
type Validation = {
  passed: boolean;
  summary: string;
  checks: ValidationCheck[];
  regressions: string[];
  followUps: string[];
};
function extractValidation(value: unknown): Validation | null {
  const row = unwrapRow(value);
  if (!row) return null;
  const summary = asString(row.summary);
  if (summary === undefined) return null;
  const checks = asArray(row.checks).map((c) => {
    const rec = isRecord(c) ? c : {};
    return {
      name: asString(rec.name) ?? "check",
      status: asString(rec.status) ?? "skipped",
      details: asString(rec.details) ?? null,
    };
  });
  return {
    passed: row.passed !== false,
    summary,
    checks,
    regressions: asStringArray(row.regressions),
    followUps: asStringArray(row.followUps),
  };
}

type MissionFinal = {
  status: string;
  summary: string;
  completedMilestones: number;
  totalMilestones: number;
  validationPassed: boolean;
  remainingRisks: string[];
  nextActions: string[];
  markdownBody: string;
};
function extractFinal(value: unknown): MissionFinal | null {
  const row = unwrapRow(value);
  if (!row) return null;
  const summary = asString(row.summary);
  if (summary === undefined) return null;
  return {
    status: asString(row.status) ?? "completed",
    summary,
    completedMilestones: typeof row.completedMilestones === "number" ? row.completedMilestones : 0,
    totalMilestones: typeof row.totalMilestones === "number" ? row.totalMilestones : 0,
    validationPassed: row.validationPassed !== false,
    remainingRisks: asStringArray(row.remainingRisks),
    nextActions: asStringArray(row.nextActions),
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
  ".pill .mono { font-family:ui-monospace,monospace; }",
  ".toolbar { display:flex; align-items:center; gap:8px; flex:1; justify-content:flex-end; flex-wrap:wrap; }",
  ".prompt { flex:1; min-width:200px; max-width:420px; height:30px; padding:0 10px; border:1px solid var(--border); border-radius:6px; background:var(--panel); color:var(--text); }",
  ".button { height:30px; padding:0 12px; border:1px solid var(--border); border-radius:6px; background:var(--panel); color:var(--text); cursor:pointer; font-weight:500; }",
  ".button:hover { background:var(--card); }",
  ".button.primary { background:var(--primary); color:#fff; border-color:var(--primary); }",
  ".button.ok { background:var(--ok); color:#04210f; border-color:var(--ok); }",
  ".button.danger { color:var(--err); }",
  ".button:disabled { opacity:0.4; cursor:not-allowed; }",
  ".badge { font-size:11px; font-weight:600; text-transform:uppercase; padding:3px 8px; border-radius:5px; border:1px solid var(--border); }",
  ".badge.running { color:var(--warn); border-color:var(--warn); }",
  ".badge.finished { color:var(--ok); border-color:var(--ok); }",
  ".badge.failed { color:var(--err); border-color:var(--err); }",
  ".main { display:grid; grid-template-columns:1.4fr 1fr 240px; flex:1; overflow:hidden; }",
  "@media (max-width:1000px) { .main { grid-template-columns:1fr; overflow:auto; } .sidebar { border-left:0; border-top:1px solid var(--border); } }",
  ".col { padding:18px 20px; overflow:auto; }",
  ".col.left { }",
  ".col.mid { border-left:1px solid var(--border); }",
  ".section-head { margin:0 0 10px; font-size:11px; text-transform:uppercase; letter-spacing:0.05em; color:var(--muted); }",
  ".card { background:var(--card); border:1px solid var(--border); border-radius:10px; padding:16px 18px; margin-bottom:16px; }",
  ".card h3 { margin:0 0 6px; font-size:14px; }",
  ".goal { font-size:15px; font-weight:600; margin-bottom:8px; }",
  ".muted { color:var(--muted); }",
  ".chips { display:flex; flex-wrap:wrap; gap:6px; margin-top:8px; }",
  ".chip { font-size:11px; padding:3px 8px; border-radius:999px; background:var(--panel); border:1px solid var(--border); color:var(--muted); }",
  ".list { list-style:none; margin:8px 0 0; padding:0; }",
  ".list li { padding:4px 0; border-bottom:1px solid var(--border); }",
  ".list li:last-child { border-bottom:0; }",
  ".approval { border-color:var(--warn); }",
  ".approval-actions { display:flex; gap:8px; margin-top:12px; }",
  ".note-input { width:100%; height:30px; padding:0 10px; margin-top:8px; border:1px solid var(--border); border-radius:6px; background:var(--panel); color:var(--text); }",
  ".timeline { list-style:none; margin:0; padding:0; }",
  ".ms-row { display:flex; gap:12px; padding:12px 0; border-bottom:1px solid var(--border); align-items:flex-start; }",
  ".ms-row:last-child { border-bottom:0; }",
  ".ms-dot { flex:0 0 26px; height:26px; border-radius:50%; background:var(--panel); border:1px solid var(--border); display:flex; align-items:center; justify-content:center; font-size:11px; color:var(--muted); }",
  ".ms-dot.active { border-color:var(--warn); color:var(--warn); }",
  ".ms-dot.done { border-color:var(--ok); color:var(--ok); }",
  ".ms-body { flex:1; min-width:0; }",
  ".ms-title { font-weight:600; }",
  ".ms-meta { font-size:11px; color:var(--muted); margin-top:2px; }",
  ".feature-grid { display:grid; grid-template-columns:1fr 1fr; gap:10px; margin-top:8px; }",
  "@media (max-width:560px) { .feature-grid { grid-template-columns:1fr; } }",
  ".feature { background:var(--panel); border:1px solid var(--border); border-radius:8px; padding:10px 12px; }",
  ".feature .ftitle { font-weight:600; font-size:12px; }",
  ".check { display:flex; gap:8px; padding:5px 0; align-items:baseline; }",
  ".check .cstatus { font-size:11px; font-weight:600; }",
  ".cstatus.passed { color:var(--ok); }",
  ".cstatus.failed { color:var(--err); }",
  ".cstatus.skipped { color:var(--muted); }",
  ".empty { color:var(--muted); text-align:center; padding:40px 16px; }",
  ".empty .button { margin-top:14px; }",
  ".launch-form { max-width:520px; margin:24px auto; }",
  ".launch-form textarea { width:100%; min-height:90px; padding:10px; border:1px solid var(--border); border-radius:8px; background:var(--panel); color:var(--text); resize:vertical; }",
  ".field { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:8px 0; border-bottom:1px solid var(--border); }",
  ".field label { color:var(--muted); }",
  ".field input[type=number] { width:64px; height:28px; padding:0 8px; border:1px solid var(--border); border-radius:6px; background:var(--panel); color:var(--text); }",
  ".sidebar { border-left:1px solid var(--border); background:var(--panel); overflow:auto; }",
  ".side-head { padding:12px 16px; font-size:11px; text-transform:uppercase; letter-spacing:0.04em; color:var(--muted); border-bottom:1px solid var(--border); }",
  ".run-row { width:100%; text-align:left; padding:10px 16px; border:0; border-bottom:1px solid var(--border); background:transparent; color:var(--text); cursor:pointer; display:flex; justify-content:space-between; gap:8px; align-items:center; }",
  ".run-row:hover { background:var(--card); }",
  ".run-row.active { background:var(--card); box-shadow:inset 2px 0 0 var(--primary); }",
  ".run-row .mono { font-family:ui-monospace,monospace; font-size:11px; }",
  ".report pre { white-space:pre-wrap; word-break:break-word; background:var(--panel); border:1px solid var(--border); border-radius:8px; padding:12px; font-size:12px; }",
  ".final-stats { display:flex; gap:16px; margin:8px 0; }",
  ".final-stats .stat { font-size:20px; font-weight:700; }",
  ".final-stats .stat small { display:block; font-size:10px; font-weight:500; color:var(--muted); text-transform:uppercase; }",
].join("\n");

function statusClass(status: string | undefined) {
  if (status === "running" || status === "continued") return "running";
  if (status === "finished") return "finished";
  if (status === "failed" || status === "cancelled") return "failed";
  return "";
}

function MilestoneDetail(props: { runId: string | undefined; index: number; milestone: Milestone }) {
  const { runId, index, milestone } = props;
  const integrate = useGatewayNodeOutput({
    runId,
    nodeId: "mission:milestone:" + (index + 1) + ":integrate",
    iteration: 0,
  });
  const validate = useGatewayNodeOutput({
    runId,
    nodeId: "mission:milestone:" + (index + 1) + ":validate",
    iteration: 0,
  });
  const integration = useMemo(() => extractIntegration(integrate.data), [integrate.data]);
  const validation = useMemo(() => extractValidation(validate.data), [validate.data]);

  return (
    <div className="card" data-testid="mission-active-milestone">
      <h3>{milestone.title}</h3>
      <div className="muted">{milestone.objective}</div>

      <div style={{ marginTop: 12 }}>
        <p className="section-head">Integration</p>
        {integration ? (
          <div className="feature">
            <div className="ftitle">{integration.status}</div>
            <div className="muted">{integration.summary}</div>
            {integration.mergedBranches.length > 0 ? (
              <div className="chips">
                {integration.mergedBranches.map((b, i) => (
                  <span className="chip" key={i}>{b}</span>
                ))}
              </div>
            ) : null}
            {integration.conflictedBranches.length > 0 ? (
              <div className="chips">
                {integration.conflictedBranches.map((b, i) => (
                  <span className="chip" key={i} style={{ color: "var(--err)" }}>{b}</span>
                ))}
              </div>
            ) : null}
            {integration.filesChanged.length === 0 ? (
              <div className="muted" style={{ marginTop: 6 }}>No files changed.</div>
            ) : null}
          </div>
        ) : (
          <div className="muted">Awaiting integration.</div>
        )}
      </div>

      <div style={{ marginTop: 12 }}>
        <p className="section-head">Validation</p>
        {validation ? (
          <div className="feature" data-testid="mission-validation">
            <div className="ftitle">
              <span className={"cstatus " + (validation.passed ? "passed" : "failed")}>
                {validation.passed ? "PASSED" : "FAILED"}
              </span>{" "}
              {validation.summary}
            </div>
            {validation.checks.length > 0 ? (
              <div style={{ marginTop: 6 }}>
                {validation.checks.map((c, i) => (
                  <div className="check" key={i}>
                    <span className={"cstatus " + c.status}>{c.status}</span>
                    <span>{c.name}{c.details ? " — " + c.details : ""}</span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="muted" style={{ marginTop: 6 }}>No individual checks reported.</div>
            )}
            {validation.followUps.length > 0 ? (
              <ul className="list">
                {validation.followUps.map((f, i) => (
                  <li key={i}>Follow-up: {f}</li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : (
          <div className="muted">Awaiting validation.</div>
        )}
      </div>
    </div>
  );
}

function App() {
  const [selectedRunId, setSelectedRunId] = useState<string | undefined>(runIdFromUrl());
  const [prompt, setPrompt] = useState("Describe the mission goal.");
  const [requireApproval, setRequireApproval] = useState(true);
  const [maxMilestones, setMaxMilestones] = useState(6);
  const [maxConcurrency, setMaxConcurrency] = useState(3);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const runsQuery = useGatewayRuns({ filter: { limit: 20 } });
  const actions = useGatewayActions();

  const missionRuns = useMemo(
    () =>
      ((runsQuery.data ?? []) as RunSummary[]).filter(
        (r) => !r.workflowKey || r.workflowKey === WORKFLOW_KEY,
      ),
    [runsQuery.data],
  );
  const activeRunId = selectedRunId ?? runIdFromUrl() ?? missionRuns[0]?.runId;
  const activeRun = missionRuns.find((r) => r.runId === activeRunId);

  const runDetail = useGatewayRun(activeRunId);
  const stream = useGatewayRunEvents(activeRunId, { afterSeq: 0 });
  const approvalsQuery = useGatewayApprovals(
    activeRunId ? { filter: { runId: activeRunId } } : {},
  );

  const planOutput = useGatewayNodeOutput({ runId: activeRunId, nodeId: "mission:plan", iteration: 0 });
  const approvalOutput = useGatewayNodeOutput({ runId: activeRunId, nodeId: "mission:approve-plan", iteration: 0 });
  const finalOutput = useGatewayNodeOutput({ runId: activeRunId, nodeId: "mission:final", iteration: 0 });

  const plan = useMemo(() => extractPlan(planOutput.data), [planOutput.data]);
  const approval = useMemo(() => extractApproval(approvalOutput.data), [approvalOutput.data]);
  const final = useMemo(() => extractFinal(finalOutput.data), [finalOutput.data]);

  const pendingApproval = useMemo(() => {
    const list = (approvalsQuery.data ?? []) as ApprovalSummary[];
    return list.find((a) => a.runId === activeRunId && a.nodeId === "mission:approve-plan");
  }, [approvalsQuery.data, activeRunId]);

  const runStatus = (runDetail.data as RunSummary | undefined)?.status ?? activeRun?.status;
  const eventCount = (stream.events ?? []).length;

  // Determine which milestone is active from completed validate events.
  const activeIndex = useMemo(() => {
    const events = stream.events ?? [];
    let highestPassed = -1;
    for (const ev of events) {
      const rec: Record<string, unknown> = isRecord(ev) ? ev : {};
      const nodeId = asString(rec.nodeId) ?? "";
      const match = nodeId.match(/^mission:milestone:(\d+):(validate|revalidate)$/);
      if (match && (asString(rec.type) ?? "").includes("complete")) {
        const idx = Number(match[1]) - 1;
        if (idx > highestPassed) highestPassed = idx;
      }
    }
    return highestPassed + 1;
  }, [stream.events]);

  async function refresh() {
    await Promise.all([
      runsQuery.refetch(),
      runDetail.refetch(),
      planOutput.refetch(),
      approvalOutput.refetch(),
      finalOutput.refetch(),
      approvalsQuery.refetch(),
    ]);
  }
  async function launch() {
    setBusy(true);
    try {
      const run = await actions.launchRun({
        workflow: WORKFLOW_KEY,
        input: {
          prompt,
          requirePlanApproval: requireApproval,
          maxMilestones,
          maxConcurrency,
        },
      });
      setSelectedRunId(run.runId);
      await refresh();
    } finally {
      setBusy(false);
    }
  }
  async function decide(approved: boolean) {
    if (!pendingApproval) return;
    setBusy(true);
    try {
      await actions.submitApproval({
        runId: pendingApproval.runId,
        nodeId: pendingApproval.nodeId,
        iteration: pendingApproval.iteration,
        decision: { approved, note: note || undefined },
      });
      setNote("");
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

  const hasAnyRun = Boolean(activeRunId);
  const timelineMilestones = plan?.milestones ?? [];

  return (
    <main className="shell" data-testid="mission-ui">
      <style>{styles}</style>
      <header className="topbar">
        <div className="title-group">
          <h1>Mission</h1>
          <span className="pill" data-testid="mission-runid">
            <span className="mono">{hasAnyRun ? shortRunId(activeRunId) : "No run"}</span>
          </span>
          {hasAnyRun ? (
            <span className={"badge " + statusClass(runStatus)} data-testid="mission-status">
              {runStatus ?? "idle"}
            </span>
          ) : null}
          {hasAnyRun ? <span className="pill">{eventCount} events</span> : null}
        </div>
        <div className="toolbar">
          <input
            className="prompt"
            data-testid="mission-prompt"
            value={prompt}
            onChange={(e) => setPrompt(e.currentTarget.value)}
            placeholder="What is the mission?"
          />
          <button className="button" data-testid="mission-refresh" onClick={() => void refresh()} disabled={busy}>
            Refresh
          </button>
          {statusClass(runStatus) === "running" ? (
            <button className="button danger" data-testid="mission-cancel" onClick={() => void cancel()} disabled={busy}>
              Cancel
            </button>
          ) : null}
          <button className="button primary" data-testid="mission-launch" onClick={() => void launch()} disabled={busy}>
            Launch Mission
          </button>
        </div>
      </header>

      <div className="main">
        <div className="col left">
          {!hasAnyRun ? (
            <div className="launch-form" data-testid="mission-empty">
              <p className="section-head">Launch a mission</p>
              <textarea
                data-testid="mission-launch-prompt"
                value={prompt}
                onChange={(e) => setPrompt(e.currentTarget.value)}
                placeholder="Describe the mission goal."
              />
              <div className="field">
                <label htmlFor="m-approval">Require plan approval</label>
                <input
                  id="m-approval"
                  type="checkbox"
                  checked={requireApproval}
                  onChange={(e) => setRequireApproval(e.currentTarget.checked)}
                />
              </div>
              <div className="field">
                <label htmlFor="m-milestones">Max milestones</label>
                <input
                  id="m-milestones"
                  type="number"
                  min={1}
                  max={MAX_MILESTONES * 3}
                  value={maxMilestones}
                  onChange={(e) => setMaxMilestones(Number(e.currentTarget.value) || 1)}
                />
              </div>
              <div className="field">
                <label htmlFor="m-concurrency">Max concurrency</label>
                <input
                  id="m-concurrency"
                  type="number"
                  min={1}
                  max={10}
                  value={maxConcurrency}
                  onChange={(e) => setMaxConcurrency(Number(e.currentTarget.value) || 1)}
                />
              </div>
              <button
                className="button primary"
                data-testid="mission-launch-empty"
                onClick={() => void launch()}
                disabled={busy}
                style={{ marginTop: 14 }}
              >
                Launch Mission
              </button>
            </div>
          ) : (
            <div data-testid="mission-plan-panel">
              <p className="section-head">Mission plan</p>
              {plan ? (
                <div className="card">
                  <div className="goal" data-testid="mission-goal">{plan.goal || "Mission goal"}</div>
                  <div className="muted" data-testid="mission-summary">{plan.summary}</div>
                  {plan.assumptions.length > 0 ? (
                    <>
                      <p className="section-head" style={{ marginTop: 12 }}>Assumptions</p>
                      <ul className="list">
                        {plan.assumptions.map((a, i) => <li key={i}>{a}</li>)}
                      </ul>
                    </>
                  ) : null}
                  {plan.risks.length > 0 ? (
                    <>
                      <p className="section-head" style={{ marginTop: 12 }}>Risks</p>
                      <ul className="list">
                        {plan.risks.map((r, i) => <li key={i}>{r}</li>)}
                      </ul>
                    </>
                  ) : null}
                  {plan.outOfScope.length > 0 ? (
                    <div className="chips">
                      {plan.outOfScope.map((o, i) => <span className="chip" key={i}>out: {o}</span>)}
                    </div>
                  ) : null}
                </div>
              ) : (
                <div className="card muted">Waiting for the plan to be generated…</div>
              )}

              {pendingApproval ? (
                <div className="card approval" data-testid="mission-approval">
                  <h3>{pendingApproval.requestTitle ?? "Approve mission plan?"}</h3>
                  <div className="muted">{pendingApproval.requestSummary ?? "Review the scoped plan before workers begin."}</div>
                  <input
                    className="note-input"
                    data-testid="mission-approval-note"
                    value={note}
                    onChange={(e) => setNote(e.currentTarget.value)}
                    placeholder="Optional note"
                  />
                  <div className="approval-actions">
                    <button className="button ok" data-testid="mission-approve" onClick={() => void decide(true)} disabled={busy}>
                      Approve
                    </button>
                    <button className="button danger" data-testid="mission-deny" onClick={() => void decide(false)} disabled={busy}>
                      Deny
                    </button>
                  </div>
                </div>
              ) : approval ? (
                <div className="card" data-testid="mission-approval-result">
                  <h3>
                    Plan{" "}
                    <span className={"badge " + (approval.approved ? "finished" : "failed")}>
                      {approval.approved ? "approved" : "denied"}
                    </span>
                  </h3>
                  {approval.note ? <div className="muted">{approval.note}</div> : null}
                  {approval.decidedBy ? <div className="muted">by {approval.decidedBy}</div> : null}
                </div>
              ) : null}

              <p className="section-head" style={{ marginTop: 8 }}>Milestone timeline</p>
              {timelineMilestones.length > 0 ? (
                <ul className="timeline" data-testid="mission-timeline">
                  {timelineMilestones.map((m, i) => {
                    const done = i < activeIndex;
                    const active = i === activeIndex && statusClass(runStatus) === "running";
                    return (
                      <li className="ms-row" key={m.id} data-testid={"mission-milestone-" + m.id}>
                        <span className={"ms-dot" + (done ? " done" : active ? " active" : "")}>
                          {done ? "✓" : i + 1}
                        </span>
                        <span className="ms-body">
                          <span className="ms-title">{m.title}</span>
                          <span className="ms-meta">
                            {m.featureCount} feature{m.featureCount === 1 ? "" : "s"}
                            {done ? " · done" : active ? " · in progress" : " · pending"}
                          </span>
                        </span>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <div className="muted">No milestones planned yet.</div>
              )}
            </div>
          )}
        </div>

        <div className="col mid">
          {final ? (
            <div className="report" data-testid="mission-final">
              <p className="section-head">Mission report</p>
              <div className="card">
                <h3>
                  <span className={"badge " + (final.status === "completed" ? "finished" : final.status === "cancelled" ? "failed" : "running")}>
                    {final.status}
                  </span>
                </h3>
                <div className="muted" data-testid="mission-final-summary">{final.summary}</div>
                <div className="final-stats">
                  <span className="stat">
                    {final.completedMilestones}/{final.totalMilestones}
                    <small>milestones</small>
                  </span>
                  <span className="stat">
                    {final.validationPassed ? "PASS" : "FAIL"}
                    <small>validation</small>
                  </span>
                </div>
                {final.nextActions.length > 0 ? (
                  <>
                    <p className="section-head" style={{ marginTop: 12 }}>Next actions</p>
                    <ul className="list">
                      {final.nextActions.map((a, i) => <li key={i}>{a}</li>)}
                    </ul>
                  </>
                ) : null}
                {final.remainingRisks.length > 0 ? (
                  <>
                    <p className="section-head" style={{ marginTop: 12 }}>Remaining risks</p>
                    <ul className="list">
                      {final.remainingRisks.map((r, i) => <li key={i}>{r}</li>)}
                    </ul>
                  </>
                ) : null}
              </div>
              {final.markdownBody ? (
                <div className="card">
                  <p className="section-head">Full report</p>
                  <pre>{final.markdownBody}</pre>
                </div>
              ) : null}
            </div>
          ) : hasAnyRun && plan && timelineMilestones.length > 0 && activeIndex < timelineMilestones.length ? (
            <>
              <p className="section-head">Active milestone</p>
              <MilestoneDetail runId={activeRunId} index={activeIndex} milestone={timelineMilestones[activeIndex]} />
            </>
          ) : (
            <div className="empty" data-testid="mission-detail-empty">
              {hasAnyRun ? "Milestone work and the final report will appear here." : "Launch a mission to see milestone progress."}
            </div>
          )}
        </div>

        <aside className="sidebar">
          <div className="side-head">Recent missions</div>
          {missionRuns.map((r) => (
            <button
              key={r.runId}
              className={"run-row" + (r.runId === activeRunId ? " active" : "")}
              data-testid={"mission-run-" + r.runId}
              onClick={() => setSelectedRunId(r.runId)}
            >
              <span className="mono">{shortRunId(r.runId)}</span>
              <span className={"badge " + statusClass(r.status)}>{r.status ?? "?"}</span>
            </button>
          ))}
          {missionRuns.length === 0 ? <div className="empty">No runs yet.</div> : null}
        </aside>
      </div>
    </main>
  );
}

createGatewayReactRoot(<App />);
