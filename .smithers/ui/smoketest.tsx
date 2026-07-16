/** @jsxImportSource react */
import { useMemo, useState } from "react";
import {
  createGatewayReactRoot,
  useGatewayNodeOutput,
  useGatewayRun,
  useGatewayRunEvents,
  useGatewayRuns,
} from "smithers-orchestrator/gateway-react";
import { WorkflowUiStyles } from "smithers-orchestrator/gateway-ui";

const WORKFLOW_KEY = "smoketest";
const AREAS = [
  { nodeId: "onboarding-human", title: "Human onboarding" },
  { nodeId: "onboarding-agent", title: "Agent onboarding" },
  { nodeId: "features", title: "Release features" },
  { nodeId: "workflow-ui", title: "Workflow UI over gateway" },
] as const;
const REPORT_NODE = "report";

type Finding = { area: string; status: "pass" | "fail" | "skipped"; evidence: string };
type Verdict = { passed?: boolean; summary?: string; findings: Finding[]; reproSteps: string[] };
type NodeState = "pending" | "running" | "done" | "failed";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function runIdFromUrl(): string | undefined {
  if (typeof location === "undefined") return undefined;
  return new URLSearchParams(location.search).get("runId") ?? undefined;
}
function unwrapRow(value: unknown): Record<string, unknown> | null {
  const response = isRecord(value) ? value : {};
  const data = isRecord(response.data) ? response.data : response;
  return isRecord(data.row) ? (data.row as Record<string, unknown>) : null;
}
/** Output columns store arrays as JSON strings and booleans as 0/1. */
function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
function toVerdict(value: unknown): Verdict | null {
  const row = unwrapRow(value);
  if (!row) return null;
  const findingsRaw = parseMaybeJson(row.findings);
  const reproRaw = parseMaybeJson(row.reproSteps ?? row.repro_steps);
  return {
    passed: row.passed === true || row.passed === 1,
    summary: typeof row.summary === "string" ? row.summary : "",
    findings: Array.isArray(findingsRaw)
      ? findingsRaw.filter(isRecord).map((f) => ({
          area: String(f.area ?? ""),
          status: (f.status === "pass" || f.status === "skipped" ? f.status : "fail") as Finding["status"],
          evidence: String(f.evidence ?? ""),
        }))
      : [],
    reproSteps: Array.isArray(reproRaw) ? reproRaw.map((s) => String(s)) : [],
  };
}

function StatusPill({ state }: { state: NodeState }) {
  const label = { pending: "pending", running: "running", done: "done", failed: "failed" }[state];
  return <span className={`pill pill-${state}`}>{label}</span>;
}

function VerdictBadge({ passed }: { passed: boolean | undefined }) {
  if (passed === undefined) return <span className="pill pill-pending">no verdict yet</span>;
  return <span className={`pill ${passed ? "pill-done" : "pill-failed"}`}>{passed ? "PASS" : "FAIL"}</span>;
}

function AreaCard({ runId, nodeId, title, state, refreshKey }: {
  runId: string;
  nodeId: string;
  title: string;
  state: NodeState;
  refreshKey: number;
}) {
  // Key on refreshKey so a panel mounted while the node was pending refetches
  // once the node finishes instead of keeping the stale empty fetch.
  const output = useGatewayNodeOutput({ runId, nodeId, iteration: 0 });
  const verdict = toVerdict(output.data);
  return (
    <section className="card">
      <header className="card-head">
        <h2>{title}</h2>
        <span className="head-pills">
          <StatusPill state={state} />
          <VerdictBadge passed={verdict?.passed} />
        </span>
      </header>
      {verdict?.summary ? <p className="summary">{verdict.summary}</p> : null}
      {verdict && verdict.findings.length > 0 ? (
        <table className="findings">
          <tbody>
            {verdict.findings.map((f, i) => (
              <tr key={`${f.area}-${i}`} className={`finding-${f.status}`}>
                <td className="finding-area">{f.area}</td>
                <td className="finding-status">{f.status}</td>
                <td>{f.evidence}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      <span style={{ display: "none" }}>{refreshKey}</span>
    </section>
  );
}

function RunView({ runId }: { runId: string }) {
  const run = useGatewayRun(runId);
  const events = useGatewayRunEvents(runId);
  const { nodeStates, finishedCount } = useMemo(() => {
    const states: Record<string, NodeState> = {};
    let finished = 0;
    for (const frame of events.events ?? []) {
      const payload = isRecord(frame) && isRecord(frame.payload) ? frame.payload : null;
      if (!payload) continue;
      const kind = String(payload.event ?? "");
      const inner = isRecord(payload.payload) ? payload.payload : null;
      const nodeId = inner ? String(inner.nodeId ?? "") : "";
      if (!nodeId) continue;
      if (kind === "NodeStarted") states[nodeId] = "running";
      if (kind === "NodeFinished") {
        states[nodeId] = "done";
        finished += 1;
      }
      if (kind === "NodeFailed") states[nodeId] = "failed";
    }
    return { nodeStates: states, finishedCount: finished };
  }, [events.events]);

  const status = String(run.data?.status ?? "loading");
  return (
    <main className="wrap">
      <header className="page-head">
        <h1>Release smoke test</h1>
        <p>
          run <code>{runId}</code> — status <strong>{status}</strong>
        </p>
      </header>
      <div className="grid">
        {AREAS.map((area) => (
          <AreaCard
            key={`${area.nodeId}:${finishedCount}`}
            runId={runId}
            nodeId={area.nodeId}
            title={area.title}
            state={nodeStates[area.nodeId] ?? "pending"}
            refreshKey={finishedCount}
          />
        ))}
      </div>
      <AreaCard
        key={`${REPORT_NODE}:${finishedCount}`}
        runId={runId}
        nodeId={REPORT_NODE}
        title="Final report"
        state={nodeStates[REPORT_NODE] ?? "pending"}
        refreshKey={finishedCount}
      />
    </main>
  );
}

function App() {
  const [pinned] = useState(runIdFromUrl);
  const runs = useGatewayRuns();
  const latest = (runs.data ?? []).find((run: { workflowKey?: string; runId?: string }) =>
    String(run.workflowKey ?? "").includes(WORKFLOW_KEY),
  );
  const runId = pinned ?? (latest ? String(latest.runId ?? "") : "");
  return (
    <>
      <WorkflowUiStyles />
      <style>{`
        .wrap { max-width: 1080px; margin: 0 auto; padding: 1.5rem; }
        .page-head h1 { margin: 0 0 .25rem; }
        .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 1rem; margin: 1rem 0; }
        .card { border: 1px solid var(--border, #3333); border-radius: 8px; padding: 1rem; }
        .card-head { display: flex; justify-content: space-between; align-items: baseline; gap: .5rem; }
        .card-head h2 { margin: 0; font-size: 1rem; }
        .head-pills { display: flex; gap: .4rem; }
        .pill { border-radius: 999px; padding: .1rem .6rem; font-size: .75rem; border: 1px solid transparent; }
        .pill-pending { background: #8882; }
        .pill-running { background: #2563eb22; border-color: #2563eb66; }
        .pill-done { background: #16a34a22; border-color: #16a34a66; }
        .pill-failed { background: #dc262622; border-color: #dc262666; }
        .summary { margin: .6rem 0 0; }
        .findings { width: 100%; margin-top: .6rem; border-collapse: collapse; font-size: .85rem; }
        .findings td { padding: .25rem .5rem; border-top: 1px solid #8883; vertical-align: top; }
        .finding-area { white-space: nowrap; font-family: monospace; }
        .finding-status { white-space: nowrap; }
        .finding-fail .finding-status { color: #dc2626; font-weight: 600; }
        .finding-pass .finding-status { color: #16a34a; }
      `}</style>
      {runId ? <RunView runId={runId} /> : <main className="wrap"><p>No smoketest run yet.</p></main>}
    </>
  );
}

createGatewayReactRoot(<App />);
