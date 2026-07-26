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
import { WorkflowUiStyles } from "smithers-orchestrator/gateway-ui";

const WORKFLOW_KEY = "close-issues";

type RunSummary = { runId: string; workflowKey?: string; status?: string };
type ApprovalSummary = {
  runId: string;
  nodeId: string;
  iteration: number;
  request?: { title?: string; summary?: string };
};
type Issue = { number: number; title: string };
type NodeStatus = "pending" | "running" | "done" | "failed" | "waiting" | "skipped";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
function shortRunId(id: string | undefined) {
  return id ? id.slice(0, 8) : "--";
}
function runIdFromUrl(): string | undefined {
  if (typeof location === "undefined") return undefined;
  return new URLSearchParams(location.search).get("runId") ?? undefined;
}
function unwrapRow(value: unknown): Record<string, unknown> | null {
  const response = isRecord(value) ? value : {};
  const data = isRecord(response.data) ? response.data : response;
  const row = isRecord(data.row) ? data.row : isRecord(data) ? data : null;
  return row;
}
/** Output columns store arrays as JSON strings — parse defensively. */
function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function extractIssues(value: unknown): { issues: Issue[]; summary: string } {
  const row = unwrapRow(value);
  if (!row) return { issues: [], summary: "" };
  const raw = parseMaybeJson(row.issues);
  const issues: Issue[] = Array.isArray(raw)
    ? raw
        .map((i): Issue | null => {
          if (!isRecord(i)) return null;
          const number = typeof i.number === "number" ? i.number : Number(i.number);
          if (!Number.isFinite(number)) return null;
          return { number, title: asString(i.title) ?? `Issue #${number}` };
        })
        .filter((i): i is Issue => i !== null)
    : [];
  return { issues, summary: asString(row.summary) ?? "" };
}

/** Latest lifecycle status per nodeId, derived from the event stream. */
function buildNodeStatus(events: unknown[]): Map<string, NodeStatus> {
  const map = new Map<string, NodeStatus>();
  for (const ev of events) {
    if (!isRecord(ev)) continue;
    const nodeId = asString(ev.nodeId);
    const type = asString(ev.type);
    if (!nodeId || !type) continue;
    if (type === "NodeFinished") map.set(nodeId, "done");
    else if (type === "NodeFailed" || type === "NodeCancelled") map.set(nodeId, "failed");
    else if (type === "NodeSkipped") map.set(nodeId, "skipped");
    else if (type === "NodeWaitingApproval") map.set(nodeId, "waiting");
    else if (type === "NodeStarted" || type === "NodeRetrying" || type === "TaskHeartbeat") {
      if (map.get(nodeId) !== "done") map.set(nodeId, "running");
    }
  }
  return map;
}

const PHASES: Array<{ key: "implement" | "review" | "pr" | "merge"; label: string; node: (n: number) => string }> = [
  { key: "implement", label: "Fix", node: (n) => `issue-${n}-implement` },
  { key: "review", label: "Review", node: (n) => `issue-${n}-review` },
  { key: "pr", label: "PR", node: (n) => `issue-${n}-pr` },
  { key: "merge", label: "Merge", node: (n) => `merge-${n}` },
];

const styles = [
  ":root{--bg:#0c0c0e;--panel:#151518;--card:#1c1c1f;--text:#eee;--muted:#8a8a8e;--border:#262629;--primary:#5e6ad2;--ok:#4ade80;--err:#f87171;--warn:#fbbf24;--run:#60a5fa;color-scheme:dark;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;}",
  "*{box-sizing:border-box;}",
  "body{margin:0;background:var(--bg);color:var(--text);font-size:13px;line-height:1.5;}",
  "button,input,textarea{font:inherit;}",
  ".shell{min-height:100vh;display:flex;flex-direction:column;}",
  ".topbar{display:flex;align-items:center;gap:12px;padding:12px 20px;border-bottom:1px solid var(--border);flex-wrap:wrap;}",
  "h1{margin:0;font-size:14px;font-weight:600;}",
  ".pill{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--muted);background:var(--panel);padding:4px 10px;border-radius:6px;border:1px solid var(--border);}",
  ".mono{font-family:ui-monospace,monospace;font-size:11px;}",
  ".spacer{flex:1;}",
  ".badge{font-size:11px;font-weight:600;text-transform:uppercase;padding:3px 8px;border-radius:5px;border:1px solid var(--border);}",
  ".badge.running{color:var(--run);border-color:var(--run);}",
  ".badge.finished{color:var(--ok);border-color:var(--ok);}",
  ".badge.failed{color:var(--err);border-color:var(--err);}",
  ".badge.waiting-approval,.badge.paused{color:var(--warn);border-color:var(--warn);}",
  ".button{height:30px;padding:0 12px;border:1px solid var(--border);border-radius:6px;background:var(--panel);color:var(--text);cursor:pointer;font-weight:500;}",
  ".button:hover{background:var(--card);}",
  ".button.primary{background:var(--primary);color:#fff;border-color:var(--primary);}",
  ".button.ok{background:var(--ok);color:#04210f;border-color:var(--ok);}",
  ".button.danger{color:var(--err);}",
  ".button:disabled{opacity:.4;cursor:not-allowed;}",
  ".content{padding:20px;max-width:1100px;width:100%;margin:0 auto;}",
  ".lead{color:var(--muted);margin:0 0 16px;}",
  ".summary{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:14px 16px;margin-bottom:18px;white-space:pre-wrap;font-size:12.5px;}",
  ".grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:14px;}",
  ".issue{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:16px;}",
  ".issue-num{font-family:ui-monospace,monospace;color:var(--primary);font-weight:700;}",
  ".issue-title{font-weight:600;margin:4px 0 14px;font-size:13px;}",
  ".phases{display:flex;gap:8px;}",
  ".phase{flex:1;text-align:center;}",
  ".dot{width:14px;height:14px;border-radius:50%;margin:0 auto 5px;background:var(--border);}",
  ".dot.running{background:var(--run);box-shadow:0 0 0 4px rgba(96,165,250,.15);}",
  ".dot.done{background:var(--ok);}",
  ".dot.failed{background:var(--err);}",
  ".dot.waiting{background:var(--warn);}",
  ".dot.skipped{background:var(--muted);}",
  ".phase-label{font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;}",
  ".gate{background:rgba(251,191,36,.08);border:1px solid var(--warn);border-radius:12px;padding:18px;margin:20px 0;}",
  ".gate h2{margin:0 0 8px;font-size:13px;color:var(--warn);}",
  ".gate pre{white-space:pre-wrap;font-family:ui-monospace,monospace;font-size:12px;margin:0 0 12px;color:#ddd;}",
  ".gate-actions{display:flex;gap:10px;align-items:center;}",
  ".note{flex:1;height:30px;padding:0 10px;border:1px solid var(--border);border-radius:6px;background:var(--panel);color:var(--text);}",
  ".banner{display:flex;gap:10px;align-items:center;padding:14px 18px;border-radius:10px;margin-bottom:18px;border:1px solid var(--border);font-weight:600;}",
  ".banner.done{background:rgba(74,222,128,.08);border-color:var(--ok);color:var(--ok);}",
  ".banner.progress{background:rgba(94,106,210,.1);border-color:var(--primary);color:#aab2f0;}",
  ".empty{color:var(--muted);text-align:center;padding:48px 16px;}",
].join("\n");

function statusClass(status: string | undefined) {
  if (status === "running" || status === "continued") return "running";
  if (status === "finished") return "finished";
  if (status === "failed" || status === "cancelled") return "failed";
  if (status === "waiting-approval" || status === "paused") return "waiting-approval";
  return "";
}

function App() {
  const [selectedRunId, setSelectedRunId] = useState<string | undefined>(runIdFromUrl());
  const [note, setNote] = useState("");
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
  const approvalsQuery = useGatewayApprovals(activeRunId ? { filter: { runId: activeRunId } } : {});
  const discoverOut = useGatewayNodeOutput({ runId: activeRunId, nodeId: "discover", iteration: 0 });

  const { issues, summary } = useMemo(() => extractIssues(discoverOut.data), [discoverOut.data]);
  const events = stream.events ?? [];
  const nodeStatus = useMemo(() => buildNodeStatus(events), [events]);

  const runStatus = (runDetail.data as RunSummary | undefined)?.status ?? activeRun?.status;
  const pendingApproval = useMemo(() => {
    const list = (approvalsQuery.data ?? []) as ApprovalSummary[];
    return list.find((a) => a.runId === activeRunId && a.nodeId === "approve-landing");
  }, [approvalsQuery.data, activeRunId]);

  const merged = useMemo(
    () => issues.filter((i) => nodeStatus.get(`merge-${i.number}`) === "done").length,
    [issues, nodeStatus],
  );
  const allMerged = issues.length > 0 && merged === issues.length;

  async function refresh() {
    await Promise.all(
      [runsQuery.refetch(), runDetail.refetch(), approvalsQuery.refetch(), discoverOut.refetch()].filter(
        Boolean,
      ) as Promise<unknown>[],
    );
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

  return (
    <main className="shell" data-testid="close-issues-ui">
      <style>{styles}</style>
      <WorkflowUiStyles mode="theme" />
      <header className="topbar">
        <h1>Close Issues · Codex</h1>
        <span className="pill">
          <span className="mono">{shortRunId(activeRunId)}</span>
        </span>
        {activeRunId ? (
          <span className={"badge " + statusClass(runStatus)} data-testid="run-status">
            {runStatus ?? "idle"}
          </span>
        ) : null}
        <span className="pill">{events.length} events</span>
        {issues.length > 0 ? (
          <span className="pill" data-testid="merged-count">
            {merged}/{issues.length} merged
          </span>
        ) : null}
        <span className="spacer" />
        <button className="button" onClick={() => void refresh()} disabled={busy}>
          Refresh
        </button>
        {activeRun && statusClass(runStatus) === "running" ? (
          <button className="button danger" onClick={() => void cancel()} disabled={busy}>
            Cancel
          </button>
        ) : null}
        <button className="button primary" data-testid="launch" onClick={() => void launch()} disabled={busy}>
          Run
        </button>
      </header>

      <div className="content">
        {!activeRunId ? (
          <div className="empty" data-testid="no-run">
            <p>
              No run yet. This workflow finds every open issue not authored by roninjin10, lets Codex fix and review
              each one in its own worktree, then lands them through a merge queue after you approve.
            </p>
            <button className="button primary" onClick={() => void launch()} disabled={busy}>
              Run it
            </button>
          </div>
        ) : (
          <>
            {allMerged ? (
              <div className="banner done" data-testid="banner-done">
                ✓ All {issues.length} fixes landed on main — their issues are now closed.
              </div>
            ) : (
              <div className="banner progress" data-testid="banner-progress">
                ○ {summary || "Discovering open issues…"}
              </div>
            )}

            {summary ? (
              <div className="summary" data-testid="discover-summary">
                {summary}
              </div>
            ) : null}

            {pendingApproval ? (
              <div className="gate" data-testid="approval-gate">
                <h2>⏸ Approval required — land these fixes to main?</h2>
                <pre>
                  {pendingApproval.request?.summary ??
                    "Review the prepared PRs, then approve to start the merge queue."}
                </pre>
                <div className="gate-actions">
                  <input
                    className="note"
                    placeholder="optional note"
                    value={note}
                    onChange={(e) => setNote(e.currentTarget.value)}
                  />
                  <button
                    className="button danger"
                    data-testid="deny"
                    onClick={() => void decide(false)}
                    disabled={busy}
                  >
                    Deny
                  </button>
                  <button className="button ok" data-testid="approve" onClick={() => void decide(true)} disabled={busy}>
                    Approve &amp; land
                  </button>
                </div>
              </div>
            ) : null}

            <div className="grid" data-testid="issue-grid">
              {issues.map((issue) => (
                <div className="issue" key={issue.number} data-testid={"issue-" + issue.number}>
                  <div className="issue-num">#{issue.number}</div>
                  <div className="issue-title">{issue.title}</div>
                  <div className="phases">
                    {PHASES.map((phase) => {
                      const st = nodeStatus.get(phase.node(issue.number)) ?? "pending";
                      return (
                        <div
                          className="phase"
                          key={phase.key}
                          data-testid={"issue-" + issue.number + "-" + phase.key}
                          data-status={st}
                        >
                          <div className={"dot " + st} />
                          <div className="phase-label">{phase.label}</div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>

            {issues.length === 0 ? <div className="empty">Waiting for issue discovery…</div> : null}
          </>
        )}
      </div>
    </main>
  );
}

createGatewayReactRoot(<App />);
