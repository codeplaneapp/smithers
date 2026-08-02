/** @jsxImportSource react */
import {
  createGatewayReactRoot,
  useGatewayApprovals,
  useGatewayActions,
  useGatewayNodeOutput,
  useGatewayRun,
  useGatewayRunEvents,
  useGatewayRuns,
} from "smthrs/gateway-react";
import { sharedDarkStandaloneThemeCss } from "./shared-theme";

const WORKFLOW_KEY = "issue-train";

type NodeStatus = "pending" | "running" | "done" | "failed" | "waiting" | "skipped";
type IssueRow = { number: number; title: string };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
function runIdFromUrl(): string | undefined {
  if (typeof location === "undefined") return undefined;
  return new URLSearchParams(location.search).get("runId") ?? undefined;
}
function unwrapRow(value: unknown): Record<string, unknown> | null {
  const response = isRecord(value) ? value : {};
  const data = isRecord(response.data) ? response.data : response;
  return isRecord(data.row) ? data.row : isRecord(data) ? data : null;
}
/** Output columns store arrays/objects as JSON strings; parse defensively. */
function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function extractIssues(value: unknown): IssueRow[] {
  const row = unwrapRow(value);
  if (!row) return [];
  const raw = parseMaybeJson(row.issues);
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry): IssueRow | null => {
      if (!isRecord(entry)) return null;
      const number = typeof entry.number === "number" ? entry.number : Number(entry.number);
      if (!Number.isFinite(number)) return null;
      return { number, title: asString(entry.title) ?? "Issue #" + number };
    })
    .filter((entry): entry is IssueRow => entry !== null);
}

function extractWaves(value: unknown): number[][] {
  const row = unwrapRow(value);
  if (!row) return [];
  const raw = parseMaybeJson(row.wavesJson);
  if (!Array.isArray(raw)) return [];
  return raw.map((wave) => (Array.isArray(wave) ? wave.map(Number).filter(Number.isFinite) : []));
}

/** Decode the durable run-event frame emitted by useGatewayRunEvents. */
function eventParts(ev: unknown): { type: string; nodeId: string } | null {
  if (!isRecord(ev)) return null;
  const payload = isRecord(ev.payload) ? ev.payload : undefined;
  const type = asString(ev.event) ?? "";
  const nodeId = asString(payload?.nodeId) ?? "";
  if (!type || !nodeId) return null;
  return { type, nodeId };
}

function buildNodeStatus(events: unknown[]): Map<string, NodeStatus> {
  const map = new Map<string, NodeStatus>();
  for (const ev of events) {
    const parts = eventParts(ev);
    if (!parts) continue;
    const { type, nodeId } = parts;
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

function dotClass(status: NodeStatus | undefined): string {
  return "dot " + (status ?? "pending");
}

const LANE_STAGES: Array<{ label: string; node: (w: number, n: number) => string }> = [
  { label: "fix", node: (w, n) => "w" + w + ":i" + n + ":fix" },
  { label: "review", node: (w, n) => "w" + w + ":i" + n + ":review" },
  { label: "commit", node: (w, n) => "w" + w + ":i" + n + ":commit" },
  { label: "verify", node: (w, n) => "w" + w + ":i" + n + ":verify-commit" },
  { label: "close", node: (w, n) => "w" + w + ":close-" + n },
];

function SummaryPanel({ runId }: { runId: string }) {
  const output = useGatewayNodeOutput({ runId, nodeId: "summary", iteration: 0 });
  const row = unwrapRow(output.data);
  if (!row || row.summary === undefined) return null;
  const details = parseMaybeJson(row.detailsJson);
  const needAttention = Array.isArray(details)
    ? details.filter((entry) => isRecord(entry) && !["closed", "landed"].includes(String(entry.disposition)))
    : [];
  return (
    <section className="panel">
      <h2>Final summary</h2>
      <p>{String(row.summary)}</p>
      {needAttention.length > 0 && (
        <div>
          <h3>Needs your input ({needAttention.length})</h3>
          <ul className="attention">
            {needAttention.map((entry, index) => {
              const record = isRecord(entry) ? entry : {};
              return (
                <li key={index}>
                  <span className="mono">#{String(record.issueNumber)}</span> [{String(record.disposition)}]{" "}
                  {String(record.title ?? "")}
                  <div className="muted">{String(record.note ?? "")}</div>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </section>
  );
}

function PlanPanel({ runId }: { runId: string }) {
  const output = useGatewayNodeOutput({ runId, nodeId: "plan", iteration: 0 });
  const row = unwrapRow(output.data);
  if (!row || row.summary === undefined) return null;
  return (
    <section className="panel">
      <h2>Plan</h2>
      <p>{String(row.summary)}</p>
    </section>
  );
}

function WaveBoard({
  waves,
  issues,
  nodeStatus,
}: {
  waves: number[][];
  issues: Map<number, IssueRow>;
  nodeStatus: Map<string, NodeStatus>;
}) {
  if (!waves.length) return <p className="muted">Waiting for triage to produce the wave plan…</p>;
  return (
    <div className="waves">
      {waves.map((numbers, w) => {
        const gate = nodeStatus.get("w" + w + ":gate");
        const push = nodeStatus.get("w" + w + ":push");
        return (
          <section className="panel" key={w}>
            <h2>
              Wave {w + 1}{" "}
              <span className="muted">
                ({numbers.length} issue{numbers.length === 1 ? "" : "s"})
              </span>
              <span className="chips">
                <span className={dotClass(gate)} title="gate" /> gate
                <span className={dotClass(push)} title="push" /> push
              </span>
            </h2>
            <div className="lanegrid">
              {numbers.map((n) => {
                const issue = issues.get(n);
                return (
                  <div className="lane" key={n}>
                    <div className="lanehead">
                      <span className="mono">#{n}</span> {issue?.title ?? ""}
                    </div>
                    <div className="stages">
                      {LANE_STAGES.map((stage) => {
                        const status = nodeStatus.get(stage.node(w, n));
                        return (
                          <span className="stage" key={stage.label}>
                            <span className={dotClass(status)} /> {stage.label}
                          </span>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function TriageStrip({ issues, nodeStatus }: { issues: IssueRow[]; nodeStatus: Map<string, NodeStatus> }) {
  if (!issues.length) return null;
  const done = issues.filter((issue) => nodeStatus.get("triage-" + issue.number) === "done").length;
  return (
    <section className="panel">
      <h2>
        Triage{" "}
        <span className="muted">
          {done}/{issues.length}
        </span>
      </h2>
      <div className="triagestrip">
        {issues.map((issue) => (
          <span
            key={issue.number}
            className={dotClass(nodeStatus.get("triage-" + issue.number))}
            title={"#" + issue.number + " " + issue.title}
          />
        ))}
      </div>
    </section>
  );
}

function ApprovalsPanel({ runId }: { runId: string }) {
  const approvals = useGatewayApprovals();
  const actions = useGatewayActions();
  const list = Array.isArray(approvals.data) ? approvals.data.filter((entry: any) => entry?.runId === runId) : [];
  if (!list.length) return null;
  return (
    <section className="panel warn">
      <h2>Pending approvals</h2>
      {list.map((entry: any) => (
        <div className="approval" key={entry.nodeId + ":" + entry.iteration}>
          <div>{String(entry.requestTitle ?? entry.nodeId)}</div>
          <button
            className="button ok"
            onClick={() =>
              actions.submitApproval({
                runId,
                nodeId: entry.nodeId,
                iteration: entry.iteration,
                decision: { approved: true },
              })
            }
          >
            Approve
          </button>
          <button
            className="button danger"
            onClick={() =>
              actions.submitApproval({
                runId,
                nodeId: entry.nodeId,
                iteration: entry.iteration,
                decision: { approved: false },
              })
            }
          >
            Deny
          </button>
        </div>
      ))}
    </section>
  );
}

function RunPicker() {
  const runs = useGatewayRuns({ filter: { limit: 25 } });
  const rows = Array.isArray(runs.data) ? runs.data.filter((run: any) => run?.workflowKey === WORKFLOW_KEY) : [];
  return (
    <div className="content">
      <section className="panel">
        <h2>Pick an issue-train run</h2>
        {rows.length === 0 && <p className="muted">No {WORKFLOW_KEY} runs found yet.</p>}
        <ul>
          {rows.map((run: any) => (
            <li key={run.runId}>
              <a href={"?runId=" + encodeURIComponent(run.runId)}>
                <span className="mono">{String(run.runId).slice(0, 12)}</span> {String(run.status ?? "")}
              </a>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function App() {
  const runId = runIdFromUrl();
  const run = useGatewayRun(runId);
  const stream = useGatewayRunEvents(runId, { afterSeq: undefined });
  const discovery = useGatewayNodeOutput({ runId, nodeId: "discover", iteration: 0 });
  const planOutput = useGatewayNodeOutput({ runId, nodeId: "plan", iteration: 0 });

  if (!runId) {
    return (
      <div className="shell">
        <style>{STYLES}</style>
        <header className="topbar">
          <h1>Issue Train</h1>
        </header>
        <RunPicker />
      </div>
    );
  }

  const status = String((run.data as any)?.status ?? "loading");
  const issues = extractIssues(discovery.data);
  const issueMap = new Map(issues.map((issue) => [issue.number, issue]));
  const waves = extractWaves(planOutput.data);
  const nodeStatus = buildNodeStatus(stream.events ?? []);
  const closedCount = issues.filter((issue) => {
    for (let w = 0; w < waves.length; w++) {
      if (nodeStatus.get("w" + w + ":close-check-" + issue.number) === "done") return true;
    }
    return (
      nodeStatus.get("final-close-check-" + issue.number) === "done" ||
      nodeStatus.get("skip-close-check-" + issue.number) === "done"
    );
  }).length;

  return (
    <div className="shell">
      <style>{STYLES}</style>
      <header className="topbar">
        <h1>Issue Train</h1>
        <span className={"badge " + status}>{status}</span>
        <span className="pill mono">{runId.slice(0, 12)}</span>
        <span className="spacer" />
        <span className="pill">{issues.length} issues</span>
        <span className="pill">{waves.length} waves</span>
        <span className="pill">{closedCount} close checks done</span>
        <span className="pill">{stream.streaming ? "live" : "idle"}</span>
      </header>
      <main className="content">
        <ApprovalsPanel runId={runId} />
        <SummaryPanel runId={runId} />
        <PlanPanel runId={runId} />
        <TriageStrip issues={issues} nodeStatus={nodeStatus} />
        <WaveBoard waves={waves} issues={issueMap} nodeStatus={nodeStatus} />
      </main>
    </div>
  );
}

const STYLES = [
  ...sharedDarkStandaloneThemeCss,
  ":root { --run:#60a5fa; }",
  ".shell{min-height:100vh;display:flex;flex-direction:column;}",
  ".topbar{display:flex;align-items:center;gap:10px;padding:12px 20px;border-bottom:1px solid var(--border);flex-wrap:wrap;position:sticky;top:0;background:var(--bg);z-index:2;}",
  "h1{margin:0;font-size:14px;font-weight:600;}",
  "h2{margin:0 0 8px;font-size:13px;font-weight:600;display:flex;align-items:center;gap:8px;flex-wrap:wrap;}",
  "h3{margin:12px 0 6px;font-size:12px;}",
  ".pill{font-size:12px;color:var(--muted);background:var(--panel);padding:3px 9px;border-radius:6px;border:1px solid var(--border);}",
  ".mono{font-family:ui-monospace,monospace;font-size:11px;}",
  ".spacer{flex:1;}",
  ".badge{font-size:11px;font-weight:600;text-transform:uppercase;padding:3px 8px;border-radius:5px;border:1px solid var(--border);}",
  ".badge.running{color:var(--run);border-color:var(--run);}",
  ".badge.finished{color:var(--ok);border-color:var(--ok);}",
  ".badge.failed{color:var(--err);border-color:var(--err);}",
  ".badge.waiting-approval,.badge.paused{color:var(--warn);border-color:var(--warn);}",
  ".content{padding:20px;max-width:1200px;width:100%;margin:0 auto;display:flex;flex-direction:column;gap:14px;}",
  ".panel{background:var(--panel);border:1px solid var(--border);border-radius:10px;padding:14px 16px;}",
  ".panel.warn{border-color:var(--warn);}",
  ".muted{color:var(--muted);}",
  ".waves{display:flex;flex-direction:column;gap:14px;}",
  ".lanegrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:10px;}",
  ".lane{background:var(--card);border:1px solid var(--border);border-radius:8px;padding:10px 12px;}",
  ".lanehead{margin-bottom:6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
  ".stages{display:flex;gap:12px;flex-wrap:wrap;}",
  ".stage{display:inline-flex;align-items:center;gap:5px;color:var(--muted);font-size:11px;}",
  ".chips{display:inline-flex;align-items:center;gap:6px;color:var(--muted);font-size:11px;font-weight:400;}",
  ".dot{width:9px;height:9px;border-radius:50%;display:inline-block;background:#3a3a3f;}",
  ".dot.running{background:var(--run);animation:pulse 1.2s ease-in-out infinite;}",
  ".dot.done{background:var(--ok);}",
  ".dot.failed{background:var(--err);}",
  ".dot.waiting{background:var(--warn);}",
  ".dot.skipped{background:#6b7280;}",
  "@keyframes pulse{0%,100%{opacity:1;}50%{opacity:.4;}}",
  ".triagestrip{display:flex;flex-wrap:wrap;gap:4px;}",
  ".attention li{margin-bottom:8px;}",
  ".approval{display:flex;align-items:center;gap:10px;margin:6px 0;}",
  ".button{height:28px;padding:0 12px;border:1px solid var(--border);border-radius:6px;background:var(--panel);color:var(--text);cursor:pointer;font-weight:500;font:inherit;}",
  ".button.ok{background:var(--ok);color:#04210f;border-color:var(--ok);}",
  ".button.danger{color:var(--err);}",
  "a{color:var(--run);text-decoration:none;}",
  "ul{margin:6px 0;padding-left:18px;}",
].join("\n");

createGatewayReactRoot(<App />);
