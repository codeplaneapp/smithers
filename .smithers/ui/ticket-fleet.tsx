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

const WORKFLOW_KEY = "ticket-fleet";

type NodeStatus = "pending" | "running" | "done" | "failed" | "waiting" | "skipped";
type Stage = "sync" | "triage" | "research" | "poc" | "planning" | "plan-approval" | "implementing" | "review" | "merge-approval" | "queue" | "landed";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
function shortId(id: string | undefined) {
  return id ? id.slice(0, 8) : "--";
}
function runIdFromUrl(): string | undefined {
  if (typeof location === "undefined") return undefined;
  return new URLSearchParams(location.search).get("runId") ?? undefined;
}
function unwrapRow(value: unknown): Record<string, unknown> | null {
  const response = isRecord(value) ? value : {};
  const data = isRecord(response.data) ? response.data : response;
  if (isRecord(data.row)) return data.row;
  // A {status, row: null, schema} envelope means the node has produced no
  // output yet — never render the envelope itself as if it were the row.
  if ("row" in data || "schema" in data || "status" in data) return null;
  return isRecord(data) && Object.keys(data).length ? data : null;
}
/** Output columns store arrays/objects as JSON strings — parse defensively. */
function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
function asBool(value: unknown): boolean {
  return value === true || value === 1 || value === "true" || value === "1";
}

/**
 * Normalize a GatewayEventFrame to {type, nodeId}. Frames are
 * { type: "event", event: <lifecycle name>, payload: { nodeId, ... }, seq } —
 * but tolerate older top-level shapes too.
 */
function normalizeEvent(raw: unknown): { type: string; nodeId: string } | null {
  if (!isRecord(raw)) return null;
  const payload = isRecord(raw.payload) ? raw.payload : undefined;
  const inner = payload && isRecord(payload.payload) ? payload.payload : undefined;
  const topType = asString(raw.type);
  const type = asString(raw.event) ?? (topType && topType !== "event" ? topType : undefined) ?? asString(payload?.event) ?? "";
  const nodeId = asString(payload?.nodeId) ?? asString(inner?.nodeId) ?? asString(raw.nodeId) ?? "";
  if (!type || !nodeId) return null;
  return { type, nodeId };
}
function buildNodeStatus(events: unknown[]): Map<string, NodeStatus> {
  const map = new Map<string, NodeStatus>();
  for (const raw of events) {
    const ev = normalizeEvent(raw);
    if (!ev) continue;
    if (ev.type === "NodeFinished") map.set(ev.nodeId, "done");
    else if (ev.type === "NodeFailed" || ev.type === "NodeCancelled") map.set(ev.nodeId, "failed");
    else if (ev.type === "NodeSkipped") map.set(ev.nodeId, "skipped");
    else if (ev.type === "NodeWaitingApproval") map.set(ev.nodeId, "waiting");
    else if (ev.type === "NodeStarted" || ev.type === "NodeRetrying" || ev.type === "TaskHeartbeat") {
      if (map.get(ev.nodeId) !== "done") map.set(ev.nodeId, "running");
    }
  }
  return map;
}

const STEP_STAGE: Array<{ match: RegExp; stage: Stage; rank: number }> = [
  { match: /^gh-verdict$/, stage: "sync", rank: 0 },
  { match: /^triage$/, stage: "triage", rank: 1 },
  { match: /^research/, stage: "research", rank: 2 },
  { match: /^poc-/, stage: "poc", rank: 3 },
  { match: /^plan(-panel.*|-comment)?$/, stage: "planning", rank: 4 },
  { match: /^plan-approval$/, stage: "plan-approval", rank: 5 },
  { match: /^(bootstrap|implement|candidate|guard)$/, stage: "implementing", rank: 6 },
  { match: /^(review|review-panel.*|candidate-gate)$/, stage: "review", rank: 7 },
  { match: /^ready$/, stage: "review", rank: 8 },
  { match: /^merge-approval$/, stage: "merge-approval", rank: 9 },
  { match: /^queue-/, stage: "queue", rank: 10 },
  { match: /^land$/, stage: "queue", rank: 11 },
  { match: /^close$/, stage: "landed", rank: 12 },
];
type IssueLane = { issueNumber: number; stage: Stage; status: NodeStatus; failedNode?: string };

function buildIssueLanes(nodeStatus: Map<string, NodeStatus>): IssueLane[] {
  const byIssue = new Map<number, { rank: number; stage: Stage; status: NodeStatus; failedNode?: string; landed: boolean }>();
  for (const [nodeId, status] of nodeStatus) {
    const match = nodeId.match(/^i(\d+):(.+)$/);
    if (!match) continue;
    const issueNumber = Number(match[1]);
    const step = match[2];
    const spec = STEP_STAGE.find((s) => s.match.test(step));
    if (!spec) continue;
    const entry = byIssue.get(issueNumber) ?? { rank: -1, stage: "triage" as Stage, status: "pending" as NodeStatus, landed: false };
    if (step === "close" && status === "done") entry.landed = true;
    if (status === "failed" && /guard/.test(step)) entry.failedNode = nodeId;
    if (spec.rank >= entry.rank && status !== "skipped") {
      entry.rank = spec.rank;
      entry.stage = spec.stage;
      entry.status = status;
    }
    byIssue.set(issueNumber, entry);
  }
  return [...byIssue.entries()]
    .map(([issueNumber, entry]) => ({
      issueNumber,
      stage: entry.landed ? ("landed" as Stage) : entry.stage,
      status: entry.status,
      failedNode: entry.failedNode,
    }))
    .sort((a, b) => a.issueNumber - b.issueNumber);
}

function sweepStats(nodeStatus: Map<string, NodeStatus>) {
  const stat = (match: (id: string) => boolean) => {
    let done = 0, running = 0, failed = 0, total = 0;
    for (const [nodeId, status] of nodeStatus) {
      if (!match(nodeId)) continue;
      total++;
      if (status === "done") done++;
      else if (status === "running") running++;
      else if (status === "failed") failed++;
    }
    return { done, running, failed, total };
  };
  return {
    local: stat((id) => id.startsWith("t:") && id.endsWith(":verdict")),
    gh: stat((id) => /^i\d+:gh-verdict$/.test(id)),
    triage: stat((id) => /^i\d+:triage$/.test(id)),
    steps: (["local-scan", "gh-scan", "ci-status", "sync-apply", "triage-apply"] as const)
      .map((id) => ({ id, status: nodeStatus.get(id) ?? "pending" })),
  };
}

const STAGE_COLUMNS: Array<{ stage: Stage; label: string }> = [
  { stage: "sync", label: "Sync check" },
  { stage: "triage", label: "Triage" },
  { stage: "research", label: "Research" },
  { stage: "poc", label: "POC" },
  { stage: "planning", label: "Planning" },
  { stage: "plan-approval", label: "Plan approval" },
  { stage: "implementing", label: "Implementing" },
  { stage: "review", label: "Review" },
  { stage: "merge-approval", label: "Merge approval" },
  { stage: "queue", label: "Merge queue" },
  { stage: "landed", label: "Landed" },
];

const styles = [
  ":root{--bg:#0c0c0e;--panel:#151518;--card:#1c1c1f;--text:#eee;--muted:#8a8a8e;--border:#262629;--primary:#5e6ad2;--ok:#4ade80;--err:#f87171;--warn:#fbbf24;--run:#60a5fa;color-scheme:dark;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;}",
  "*{box-sizing:border-box;}",
  "body{margin:0;background:var(--bg);color:var(--text);}",
  ".wrap{max-width:1400px;margin:0 auto;padding:20px;}",
  ".hdr{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:16px;}",
  ".hdr h1{font-size:18px;margin:0;}",
  ".pill{border:1px solid var(--border);border-radius:999px;padding:2px 10px;font-size:12px;color:var(--muted);}",
  ".pill.ok{color:var(--ok);border-color:var(--ok);}",
  ".pill.err{color:var(--err);border-color:var(--err);}",
  ".pill.run{color:var(--run);border-color:var(--run);}",
  ".pill.warn{color:var(--warn);border-color:var(--warn);}",
  "select{background:var(--card);color:var(--text);border:1px solid var(--border);border-radius:6px;padding:4px 8px;}",
  ".banner{background:#3b0d0d;border:1px solid var(--err);color:#fecaca;border-radius:8px;padding:12px 16px;margin-bottom:16px;font-weight:600;}",
  ".banner.amber{background:#3a2a0a;border-color:var(--warn);color:#fde68a;}",
  ".cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px;margin-bottom:16px;}",
  ".card{background:var(--panel);border:1px solid var(--border);border-radius:8px;padding:12px 14px;}",
  ".card h3{margin:0 0 8px;font-size:13px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;}",
  ".card .big{font-size:20px;font-weight:700;}",
  ".card p{margin:6px 0 0;font-size:12px;color:var(--muted);white-space:pre-wrap;}",
  ".board{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px;margin-bottom:16px;}",
  ".col{background:var(--panel);border:1px solid var(--border);border-radius:8px;padding:8px;min-height:60px;}",
  ".col h4{margin:0 0 8px;font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;}",
  ".chip{display:flex;justify-content:space-between;background:var(--card);border:1px solid var(--border);border-radius:6px;padding:4px 8px;margin-bottom:4px;font-size:12px;cursor:pointer;}",
  ".chip:hover{border-color:var(--primary);}",
  ".chip .st{font-size:10px;}",
  ".st.done{color:var(--ok);} .st.failed{color:var(--err);} .st.running{color:var(--run);} .st.waiting{color:var(--warn);}",
  ".appr{display:flex;align-items:center;gap:10px;background:var(--card);border:1px solid var(--warn);border-radius:8px;padding:8px 12px;margin-bottom:8px;}",
  ".appr .t{flex:1;font-size:13px;}",
  "button{background:var(--primary);border:0;color:white;border-radius:6px;padding:6px 12px;font-size:12px;cursor:pointer;}",
  "button.deny{background:transparent;border:1px solid var(--err);color:var(--err);}",
  ".detail{background:var(--panel);border:1px solid var(--border);border-radius:8px;padding:12px 14px;margin-bottom:16px;}",
  ".detail pre{background:var(--card);border-radius:6px;padding:8px;font-size:11px;overflow-x:auto;white-space:pre-wrap;}",
  "h2{font-size:14px;margin:20px 0 8px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;}",
].join("\n");

function OutputCard({ runId, nodeId, title, remountKey, render }: {
  runId: string;
  nodeId: string;
  title: string;
  remountKey: string;
  render: (row: Record<string, unknown>) => React.ReactNode;
}) {
  return <OutputCardInner key={remountKey + ":" + nodeId} runId={runId} nodeId={nodeId} title={title} render={render} />;
}
function OutputCardInner({ runId, nodeId, title, render }: {
  runId: string;
  nodeId: string;
  title: string;
  render: (row: Record<string, unknown>) => React.ReactNode;
}) {
  const output = useGatewayNodeOutput({ runId, nodeId, iteration: 0 });
  const row = unwrapRow(output.data);
  return (
    <div className="card">
      <h3>{title}</h3>
      {row ? render(row) : <p>pending…</p>}
    </div>
  );
}

function IssueDetail({ runId, issueNumber }: { runId: string; issueNumber: number }) {
  const triage = useGatewayNodeOutput({ runId, nodeId: "i" + issueNumber + ":triage", iteration: 0 });
  const readiness = useGatewayNodeOutput({ runId, nodeId: "i" + issueNumber + ":ready", iteration: 0 });
  const merge = useGatewayNodeOutput({ runId, nodeId: "i" + issueNumber + ":land", iteration: 0 });
  const triageRow = unwrapRow(triage.data);
  const readyRow = unwrapRow(readiness.data);
  const mergeRow = unwrapRow(merge.data);
  return (
    <div className="detail">
      <strong>Issue #{issueNumber}</strong>
      {triageRow ? (
        <p>
          difficulty: <b>{asString(triageRow.difficulty) ?? "?"}</b>
          {asBool(triageRow.needsHumanApproval) ? " · needs human approval" : ""}
          {asBool(triageRow.needsResearch) ? " · research: " + (asString(triageRow.researchKind) ?? "") : ""}
        </p>
      ) : <p>triage pending…</p>}
      {triageRow ? <pre>{asString(triageRow.rationale)}</pre> : null}
      {readyRow ? <p>readiness: {asBool(readyRow.ready) ? "ready @ " + asString(readyRow.headSha)?.slice(0, 10) : asString(readyRow.summary)}</p> : null}
      {mergeRow ? <p>merge: {asBool(mergeRow.merged) ? "landed" : "not landed"}{asBool(mergeRow.pushed) ? " + pushed" : ""} — {asString(mergeRow.summary)}</p> : null}
    </div>
  );
}

function Dashboard({ runId }: { runId: string }) {
  const run = useGatewayRun(runId);
  const { events } = useGatewayRunEvents(runId);
  const approvals = useGatewayApprovals();
  const actions = useGatewayActions();
  const [selectedIssue, setSelectedIssue] = useState<number | null>(null);

  const nodeStatus = useMemo(() => buildNodeStatus(Array.isArray(events) ? events : []), [events]);
  const lanes = useMemo(() => buildIssueLanes(nodeStatus), [nodeStatus]);
  const doneCount = useMemo(() => [...nodeStatus.values()].filter((s) => s === "done").length, [nodeStatus]);
  const remountKey = String(doneCount);

  const failedNodes = [...nodeStatus.entries()].filter(([, s]) => s === "failed").map(([nodeId]) => nodeId);
  const guardFailures = failedNodes.filter((nodeId) => nodeId.startsWith("guard:") || /:(queue-)?guard$/.test(nodeId));
  const otherFailures = failedNodes.filter((nodeId) => !guardFailures.includes(nodeId));
  const sweep = sweepStats(nodeStatus);
  const status = String((run.data as any)?.status ?? "");
  const runApprovals = (Array.isArray(approvals.data) ? approvals.data : []).filter((a: any) => a?.runId === runId);

  return (
    <div>
      {guardFailures.length ? (
        <div className="banner">
          MAIN GUARD TRIPPED — {guardFailures.join(", ")}. The run stops itself when the repo root
          leaves main or an agent writes outside its worktree. Inspect with `smithers node` before resuming anything.
        </div>
      ) : null}
      {otherFailures.length ? (
        <div className="banner amber">
          {otherFailures.length} node(s) failed (retries exhausted): {otherFailures.slice(0, 6).join(", ")}
          {otherFailures.length > 6 ? " …" : ""} — inspect with `smithers node {"<runId> <nodeId>"}`, recover with `smithers retry-task`.
        </div>
      ) : null}

      <div className="cards">
        <div className="card">
          <h3>Sweep progress</h3>
          <span className="big">{sweep.local.done}/{sweep.local.total} tickets · {sweep.gh.done}/{sweep.gh.total} issues</span>
          <p>
            {sweep.triage.total ? "triage " + sweep.triage.done + "/" + sweep.triage.total + " · " : ""}
            {sweep.local.running + sweep.gh.running + sweep.triage.running} agent(s) running
            {"\n"}
            {sweep.steps.map((s) => s.id + ": " + s.status).join(" · ")}
          </p>
        </div>
        <OutputCard runId={runId} nodeId="sync-apply" title="Two-way sync" remountKey={remountKey}
          render={(row) => (
            <div>
              <span className="big">{String(row.closedLocal ?? 0)}/{String(row.closedGithub ?? 0)}</span>
              <p>closed local / GitHub · mirrored {String(row.mirroredToGithub ?? 0)}→GH, {String(row.mirroredToLocal ?? 0)}→local · {String(row.decomposed ?? 0)} decomposed{"\n"}{asString(row.summary)}</p>
            </div>
          )} />
        <OutputCard runId={runId} nodeId="ci-status" title="Remote CI (main)" remountKey={remountKey}
          render={(row) => (
            <div>
              <span className={"pill " + (asBool(row.healthy) ? "ok" : "err")}>{asBool(row.healthy) ? "green" : "red"}</span>
              <p>{asString(row.summary)}</p>
            </div>
          )} />
        <OutputCard runId={runId} nodeId="triage-apply" title="Triage" remountKey={remountKey}
          render={(row) => {
            const selected = parseMaybeJson(row.selectedNumbers);
            return (
              <div>
                <span className="big">{Array.isArray(selected) ? selected.length : 0} selected</span>
                <p>{asString(row.summary)}</p>
              </div>
            );
          }} />
        <OutputCard runId={runId} nodeId="run-summary" title="Run summary" remountKey={remountKey}
          render={(row) => (
            <div>
              <span className="big">{String(row.merged ?? 0)} landed · {String(row.pushed ?? 0)} pushed</span>
              <p>{asString(row.summary)}</p>
            </div>
          )} />
      </div>

      {runApprovals.length ? (
        <div>
          <h2>Pending approvals</h2>
          {runApprovals.map((approval: any) => (
            <div className="appr" key={approval.nodeId + ":" + approval.iteration}>
              <div className="t">
                <b>{approval.request?.requestTitle ?? approval.requestTitle ?? approval.nodeId}</b>
                <div style={{ color: "var(--muted)", fontSize: 11 }}>{approval.request?.summary ?? ""}</div>
              </div>
              <button onClick={() => actions.submitApproval({ runId, nodeId: approval.nodeId, iteration: approval.iteration, decision: { approved: true } })}>
                Approve
              </button>
              <button className="deny" onClick={() => actions.submitApproval({ runId, nodeId: approval.nodeId, iteration: approval.iteration, decision: { approved: false } })}>
                Deny
              </button>
            </div>
          ))}
        </div>
      ) : null}

      <h2>Issue pipeline · run {shortId(runId)} · <span className={"pill " + (status === "finished" ? "ok" : /fail|error/.test(status) ? "err" : "run")}>{status || "?"}</span></h2>
      <div className="board">
        {STAGE_COLUMNS.map(({ stage, label }) => {
          const items = lanes.filter((lane) => lane.stage === stage);
          return (
            <div className="col" key={stage}>
              <h4>{label} ({items.length})</h4>
              {items.map((lane) => (
                <div className="chip" key={lane.issueNumber} onClick={() => setSelectedIssue(lane.issueNumber === selectedIssue ? null : lane.issueNumber)}>
                  <span>#{lane.issueNumber}</span>
                  <span className={"st " + lane.status}>{lane.status}</span>
                </div>
              ))}
            </div>
          );
        })}
      </div>

      {selectedIssue !== null ? <IssueDetail key={selectedIssue + ":" + remountKey} runId={runId} issueNumber={selectedIssue} /> : null}
    </div>
  );
}

function App() {
  const runs = useGatewayRuns();
  const [chosenRunId, setChosenRunId] = useState<string | undefined>(runIdFromUrl());
  const fleetRuns = (Array.isArray(runs.data) ? runs.data : (runs.data as any)?.runs ?? [])
    .filter((run: any) => String(run?.workflowKey ?? run?.workflowName ?? "").includes(WORKFLOW_KEY));
  const runId = chosenRunId ?? asString(fleetRuns[0]?.runId);
  return (
    <div className="wrap">
      <style>{styles}</style>
      <WorkflowUiStyles />
      <div className="hdr">
        <h1>Ticket Fleet</h1>
        <select value={runId ?? ""} onChange={(e) => setChosenRunId(e.target.value || undefined)}>
          <option value="">latest run</option>
          {fleetRuns.map((run: any) => (
            <option key={run.runId} value={run.runId}>
              {shortId(String(run.runId))} · {String(run.status ?? "")}
            </option>
          ))}
        </select>
      </div>
      {runId ? <Dashboard runId={runId} /> : <p style={{ color: "var(--muted)" }}>No ticket-fleet runs yet. Start one with: smithers up .smithers/workflows/ticket-fleet.tsx -d</p>}
    </div>
  );
}

createGatewayReactRoot(<App />);
