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

const WORKFLOW_KEY = "implement-packs";

const PHASES = [
  { key: "p1", title: "smithers.toon manifest" },
  { key: "p2", title: "smithers add + discovery" },
  { key: "p3", title: "eject + shadowing" },
  { key: "p4", title: "add workflow · share-pack · smithers share" },
  { key: "p5", title: "README · homepage · docs" },
] as const;

type RunSummary = { runId: string; workflowKey?: string; status?: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
function asBool(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}
function unwrapRow(value: unknown): Record<string, unknown> | null {
  const response = isRecord(value) ? value : {};
  const data = isRecord(response.data) ? response.data : response;
  return isRecord(data.row) ? data.row : isRecord(data) ? data : null;
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

type PhaseState = {
  implementSummary: string | null;
  filesChanged: string[];
  validated: boolean | undefined;
  failingSummary: string | null;
  approved: boolean | undefined;
  reviewFeedback: string | null;
};

function extractPhase(implementValue: unknown, validateValue: unknown, reviewValue: unknown): PhaseState {
  const implement = unwrapRow(implementValue);
  const validate = unwrapRow(validateValue);
  const review = unwrapRow(reviewValue);
  return {
    implementSummary: implement ? (asString(implement.summary) ?? null) : null,
    filesChanged:
      implement && Array.isArray(implement.filesChanged)
        ? implement.filesChanged.filter((f): f is string => typeof f === "string")
        : [],
    validated: validate ? (asBool(validate.allPassed) ?? true) : undefined,
    failingSummary: validate ? (asString(validate.failingSummary) ?? null) : null,
    approved: review ? asBool(review.approved) : undefined,
    reviewFeedback: review ? (asString(review.feedback) ?? null) : null,
  };
}

const styles = [
  ...sharedDarkThemeCss,
  ".button { height:30px; padding:0 12px; border:1px solid var(--border); border-radius:6px; background:var(--panel); color:var(--text); cursor:pointer; font-weight:500; font:inherit; }",
  ".main { display:grid; grid-template-columns:1fr 260px; flex:1; overflow:hidden; }",
  ".banner { display:flex; align-items:center; gap:12px; padding:14px 18px; border-radius:10px; margin-bottom:18px; border:1px solid var(--border); font-weight:600; }",
  ".banner.done { background:rgba(74,222,128,0.08); border-color:var(--ok); color:var(--ok); }",
  ".banner.blocked { background:rgba(248,113,113,0.08); border-color:var(--err); color:var(--err); }",
  ".banner.progress { background:rgba(94,106,210,0.1); border-color:var(--primary); color:#aab2f0; }",
  ".banner-sub { font-weight:400; color:var(--muted); font-size:12px; }",
  ".rail { display:flex; gap:6px; margin-bottom:18px; }",
  ".rail-step { flex:1; height:6px; border-radius:3px; background:var(--border); }",
  ".rail-step.ok { background:var(--ok); }",
  ".rail-step.active { background:var(--warn); }",
  ".rail-step.err { background:var(--err); }",
  ".phase { background:var(--card); border:1px solid var(--border); border-radius:10px; margin-bottom:14px; }",
  ".phase-head { display:flex; align-items:center; gap:10px; padding:14px 18px; }",
  ".phase-dot { flex:0 0 10px; width:10px; height:10px; border-radius:50%; background:var(--border); }",
  ".phase-dot.ok { background:var(--ok); }",
  ".phase-dot.err { background:var(--err); }",
  ".phase-dot.active { background:var(--warn); }",
  ".phase-title { font-weight:600; }",
  ".phase-meta { margin-left:auto; font-size:11px; color:var(--muted); display:flex; gap:8px; }",
  ".step { font-size:11px; padding:2px 7px; border-radius:4px; border:1px solid var(--border); color:var(--muted); }",
  ".step.ok { color:var(--ok); border-color:var(--ok); }",
  ".step.err { color:var(--err); border-color:var(--err); }",
  ".phase-body { padding:0 18px 16px; }",
  ".kv { font-size:11px; color:var(--muted); text-transform:uppercase; letter-spacing:0.04em; margin:8px 0 4px; }",
  ".chips { display:flex; flex-wrap:wrap; gap:6px; }",
  ".chip { font-family:ui-monospace,monospace; font-size:11px; background:var(--panel); border:1px solid var(--border); border-radius:5px; padding:3px 8px; }",
  ".pre { margin:0; white-space:pre-wrap; font-family:ui-monospace,monospace; font-size:11px; color:#ddd; max-height:200px; overflow:auto; background:#0e0e10; border:1px solid var(--border); border-radius:8px; padding:10px 12px; }",
  ".pre.err { border-color:var(--err); }",
  ".run-row { width:100%; text-align:left; padding:10px 16px; border:0; border-bottom:1px solid var(--border); background:transparent; color:var(--text); cursor:pointer; display:flex; justify-content:space-between; gap:8px; font:inherit; }",
  ".mono { font-family:ui-monospace,monospace; font-size:11px; }",
].join("\n");

function App() {
  const [selectedRunId, setSelectedRunId] = useState<string | undefined>(runIdFromUrl());
  const [busy, setBusy] = useState(false);
  const runsQuery = useGatewayRuns({ filter: { limit: 20 } });
  const actions = useGatewayActions();

  const runs = useMemo(
    () => ((runsQuery.data ?? []) as RunSummary[]).filter((r) => !r.workflowKey || r.workflowKey === WORKFLOW_KEY),
    [runsQuery.data],
  );
  const activeRunId = selectedRunId ?? runIdFromUrl() ?? runs[0]?.runId;
  const activeRun = runs.find((r) => r.runId === activeRunId);
  const stream = useGatewayRunEvents(activeRunId, { afterSeq: 0 });

  // Fixed phase list -> fixed hook order across renders.
  const p1i = useGatewayNodeOutput({ runId: activeRunId, nodeId: "p1:implement" });
  const p1v = useGatewayNodeOutput({ runId: activeRunId, nodeId: "p1:validate" });
  const p1r = useGatewayNodeOutput({ runId: activeRunId, nodeId: "p1:review:0" });
  const p2i = useGatewayNodeOutput({ runId: activeRunId, nodeId: "p2:implement" });
  const p2v = useGatewayNodeOutput({ runId: activeRunId, nodeId: "p2:validate" });
  const p2r = useGatewayNodeOutput({ runId: activeRunId, nodeId: "p2:review:0" });
  const p3i = useGatewayNodeOutput({ runId: activeRunId, nodeId: "p3:implement" });
  const p3v = useGatewayNodeOutput({ runId: activeRunId, nodeId: "p3:validate" });
  const p3r = useGatewayNodeOutput({ runId: activeRunId, nodeId: "p3:review:0" });
  const p4i = useGatewayNodeOutput({ runId: activeRunId, nodeId: "p4:implement" });
  const p4v = useGatewayNodeOutput({ runId: activeRunId, nodeId: "p4:validate" });
  const p4r = useGatewayNodeOutput({ runId: activeRunId, nodeId: "p4:review:0" });
  const p5i = useGatewayNodeOutput({ runId: activeRunId, nodeId: "p5:implement" });
  const p5v = useGatewayNodeOutput({ runId: activeRunId, nodeId: "p5:validate" });
  const p5r = useGatewayNodeOutput({ runId: activeRunId, nodeId: "p5:review:0" });
  const polishOut = useGatewayNodeOutput({ runId: activeRunId, nodeId: "packs:polish" });

  const raw = [
    [p1i, p1v, p1r],
    [p2i, p2v, p2r],
    [p3i, p3v, p3r],
    [p4i, p4v, p4r],
    [p5i, p5v, p5r],
  ] as const;

  const phaseStates = useMemo(
    () => raw.map(([i, v, r]) => extractPhase(i.data, v.data, r.data)),
    [
      p1i.data,
      p1v.data,
      p1r.data,
      p2i.data,
      p2v.data,
      p2r.data,
      p3i.data,
      p3v.data,
      p3r.data,
      p4i.data,
      p4v.data,
      p4r.data,
      p5i.data,
      p5v.data,
      p5r.data,
    ],
  );
  const polish = useMemo(() => unwrapRow(polishOut.data), [polishOut.data]);

  const phaseDone = (s: PhaseState) => s.validated === true && s.approved === true;
  const phaseBlocked = (s: PhaseState) => s.validated === false || s.approved === false;
  const doneCount = phaseStates.filter(phaseDone).length;
  const anyStarted = phaseStates.some((s) => s.implementSummary !== null) || polish !== null;
  const allDone = doneCount === PHASES.length;
  const runFinished = allDone && polish !== null;

  async function refresh() {
    await Promise.all([runsQuery.refetch(), ...raw.flat().map((q) => q.refetch()), polishOut.refetch()]);
  }
  async function launch() {
    setBusy(true);
    try {
      const run = await actions.launchRun({ workflow: WORKFLOW_KEY, input: {} });
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

  const bannerClass = runFinished ? "done" : phaseStates.some(phaseBlocked) ? "blocked" : "progress";
  const bannerLabel = runFinished
    ? "SHIPPED — all phases approved and polished"
    : allDone
      ? "POLISHING — final whole-feature Sol pass"
      : `PHASE ${Math.min(doneCount + 1, PHASES.length)} of ${PHASES.length}`;
  const bannerSub = runFinished
    ? "Packs feature implemented end to end. Human review is next."
    : phaseStates.some(phaseBlocked)
      ? "A phase is iterating on validation/review feedback."
      : "Luna implements, Terra validates, Sol reviews — each phase gated on the previous.";

  return (
    <main className="shell" data-testid="implement-packs-ui">
      <style>{styles}</style>
      <WorkflowUiStyles mode="theme" />
      <header className="topbar">
        <div className="title-group">
          <h1>Implement Packs — Share workflows like skills</h1>
          <span className="pill" data-testid="packs-runid">
            {shortRunId(activeRunId)}
          </span>
          {activeRun ? (
            <span className={"badge " + statusClass(activeRun.status)} data-testid="packs-status">
              {activeRun.status ?? "idle"}
            </span>
          ) : null}
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button className="button" onClick={() => void refresh()} disabled={busy}>
            Refresh
          </button>
          {activeRun && statusClass(activeRun.status) === "running" ? (
            <button className="button danger" onClick={() => void cancel()} disabled={busy}>
              Cancel
            </button>
          ) : null}
          <button className="button primary" data-testid="packs-launch" onClick={() => void launch()} disabled={busy}>
            Launch
          </button>
        </div>
      </header>

      <div className="main">
        <div className="content">
          {anyStarted || activeRunId ? (
            <>
              <div className={"banner " + bannerClass} data-testid="packs-banner">
                <span>
                  {bannerLabel}
                  <div className="banner-sub">{bannerSub}</div>
                </span>
              </div>
              <div className="rail" data-testid="packs-rail">
                {phaseStates.map((s, i) => (
                  <span
                    key={i}
                    className={
                      "rail-step " +
                      (phaseDone(s) ? "ok" : phaseBlocked(s) ? "err" : s.implementSummary !== null ? "active" : "")
                    }
                  />
                ))}
              </div>

              {PHASES.map((phase, i) => {
                const s = phaseStates[i]!;
                const dot = phaseDone(s) ? "ok" : phaseBlocked(s) ? "err" : s.implementSummary !== null ? "active" : "";
                return (
                  <section className="phase" key={phase.key} data-testid={"packs-phase-" + phase.key}>
                    <div className="phase-head">
                      <span className={"phase-dot " + dot} />
                      <span className="phase-title">
                        {i + 1}. {phase.title}
                      </span>
                      <span className="phase-meta">
                        <span className={"step " + (s.implementSummary !== null ? "ok" : "")}>luna · implement</span>
                        <span className={"step " + (s.validated === undefined ? "" : s.validated ? "ok" : "err")}>
                          terra · validate
                        </span>
                        <span className={"step " + (s.approved === undefined ? "" : s.approved ? "ok" : "err")}>
                          sol · review
                        </span>
                      </span>
                    </div>
                    {s.implementSummary !== null ? (
                      <div className="phase-body">
                        <div className="kv">Latest implement summary</div>
                        <div>{s.implementSummary}</div>
                        {s.filesChanged.length > 0 ? (
                          <>
                            <div className="kv">Files changed</div>
                            <div className="chips">
                              {s.filesChanged.map((f, j) => (
                                <span className="chip" key={j}>
                                  {f}
                                </span>
                              ))}
                            </div>
                          </>
                        ) : null}
                        {s.validated === false && s.failingSummary ? (
                          <>
                            <div className="kv">Validation failures</div>
                            <pre className="pre err">{s.failingSummary}</pre>
                          </>
                        ) : null}
                        {s.approved === false && s.reviewFeedback ? (
                          <>
                            <div className="kv">Review feedback (Sol)</div>
                            <pre className="pre err">{s.reviewFeedback}</pre>
                          </>
                        ) : null}
                      </div>
                    ) : null}
                  </section>
                );
              })}

              {polish ? (
                <section className="phase" data-testid="packs-polish">
                  <div className="phase-head">
                    <span className={"phase-dot " + (asBool(polish.polished) ? "ok" : "active")} />
                    <span className="phase-title">Final polish (Sol)</span>
                    <span className="phase-meta">{asBool(polish.polished) ? "clean" : "edits applied"}</span>
                  </div>
                  <div className="phase-body">
                    <div>{asString(polish.summary) ?? ""}</div>
                    {Array.isArray(polish.changesMade) && polish.changesMade.length > 0 ? (
                      <>
                        <div className="kv">Polish edits</div>
                        <div className="chips">
                          {polish.changesMade
                            .filter((c): c is string => typeof c === "string")
                            .map((c, j) => (
                              <span className="chip" key={j}>
                                {c}
                              </span>
                            ))}
                        </div>
                      </>
                    ) : null}
                  </div>
                </section>
              ) : null}

              <div style={{ color: "var(--muted)", marginTop: 12 }}>{(stream.events ?? []).length} events</div>
            </>
          ) : (
            <div className="empty" data-testid="packs-empty">
              <div>
                Implements the packs feature from research/packs-share-workflows-like-skills.md in five gated phases.
              </div>
              <button
                className="button primary"
                style={{ marginTop: 14 }}
                onClick={() => void launch()}
                disabled={busy}
              >
                Launch
              </button>
            </div>
          )}
        </div>

        <aside className="sidebar">
          <div className="side-head">Recent runs</div>
          {runs.map((r) => (
            <button
              key={r.runId}
              className={"run-row" + (r.runId === activeRunId ? " active" : "")}
              onClick={() => setSelectedRunId(r.runId)}
            >
              <span className="mono">{shortRunId(r.runId)}</span>
              <span className={"badge " + statusClass(r.status)}>{r.status ?? "?"}</span>
            </button>
          ))}
          {runs.length === 0 ? <div className="empty">No runs yet.</div> : null}
        </aside>
      </div>
    </main>
  );
}

createGatewayReactRoot(<App />);
