/** @jsxImportSource react */
import { useMemo, useState } from "react";
import {
  createGatewayReactRoot,
  useGatewayActions,
  useGatewayApprovals,
  useGatewayNodeOutput,
  useGatewayRunEvents,
  useGatewayRuns,
} from "smithers-orchestrator/gateway-react";

const WORKFLOW_KEY = "monitor-smithers";

type Run = { runId: string; workflowKey?: string; status?: string; createdAtMs?: number };

const S = {
  page: { fontFamily: "-apple-system,BlinkMacSystemFont,sans-serif", fontSize: 13, background: "#0c0c0e", color: "#eee", minHeight: "100vh", padding: 20 } as const,
  h: { fontSize: 14, fontWeight: 600, margin: "0 0 12px" } as const,
  sub: { fontSize: 11, color: "#8a8a8e", textTransform: "uppercase" as const, letterSpacing: 0.5, margin: "20px 0 8px" },
  card: { background: "#151518", border: "1px solid #262629", borderRadius: 8, padding: "10px 12px", marginBottom: 8 } as const,
  mono: { fontFamily: "ui-monospace,monospace", fontSize: 12 } as const,
  btn: { padding: "5px 12px", border: "1px solid #333", borderRadius: 6, background: "#1c1c20", color: "#eee", cursor: "pointer", fontSize: 12 } as const,
  input: { padding: "5px 8px", border: "1px solid #333", borderRadius: 6, background: "#151518", color: "#eee", fontSize: 12, width: 70 } as const,
  chip: (color: string) => ({ fontSize: 11, color, border: `1px solid ${color}44`, background: `${color}18`, borderRadius: 10, padding: "1px 8px" }) as const,
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
/** Node-output hooks return either the row directly or `{ row, ... }`. */
function rowOf(v: unknown): Record<string, unknown> | null {
  if (!isRecord(v)) return null;
  if (isRecord(v.row)) return v.row;
  return v;
}
function asArray(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  if (typeof v === "string" && v.trim().startsWith("[")) {
    try {
      const p = JSON.parse(v);
      return Array.isArray(p) ? p : [];
    } catch {
      return [];
    }
  }
  return [];
}
function asObject(v: unknown): Record<string, unknown> {
  if (isRecord(v)) return v;
  if (typeof v === "string" && v.trim().startsWith("{")) {
    try {
      const p = JSON.parse(v);
      return isRecord(p) ? p : {};
    } catch {
      return {};
    }
  }
  return {};
}
function statusColor(status: string | undefined) {
  if (status === "running" || status === "continued") return "#4ea1ff";
  if (status === "finished" || status === "completed") return "#3ecf8e";
  if (status === "failed" || status === "cancelled") return "#ff6369";
  return "#8a8a8e";
}
function healthColor(bucket: string) {
  if (bucket === "healthy") return "#3ecf8e";
  if (bucket === "blocked") return "#f5b83d";
  if (bucket === "stuck" || bucket === "overBudget") return "#f58a3d";
  return "#ff6369"; // failed
}

/** The watchdog's per-sweep nodes are loop-scoped; find the newest iteration from the event stream. */
function latestIteration(events: { payload?: unknown }[], nodeId: string): number {
  let max = 0;
  for (const frame of events) {
    const p = asObject(frame.payload);
    const node = p.nodeId ?? p.node_id;
    if (node !== nodeId) continue;
    const iter = Number(p.iteration ?? 0);
    if (Number.isFinite(iter) && iter > max) max = iter;
  }
  return max;
}

function FleetPanel({ runId }: { runId: string }) {
  const stream = useGatewayRunEvents(runId, { afterSeq: 0 });
  const events = stream.events ?? [];
  const pollIter = useMemo(() => latestIteration(events, "poll"), [events]);
  const classifyIter = useMemo(() => latestIteration(events, "classify"), [events]);
  const triageIter = useMemo(() => latestIteration(events, "triage"), [events]);

  const pollOut = rowOf(useGatewayNodeOutput({ runId, nodeId: "poll", iteration: pollIter }).data);
  const classifyOut = rowOf(useGatewayNodeOutput({ runId, nodeId: "classify", iteration: classifyIter }).data);
  const triageOut = rowOf(useGatewayNodeOutput({ runId, nodeId: "triage", iteration: triageIter }).data);

  const fleetRuns = asArray(pollOut?.runs).map((r) => asObject(r));
  const buckets = asObject(classifyOut?.buckets);
  const bucketOf = (fleetRunId: string): string => {
    for (const name of ["failed", "stuck", "blocked", "overBudget", "healthy"]) {
      if (asArray(buckets[name]).some((id) => String(id) === fleetRunId)) return name;
    }
    return "unclassified";
  };
  const actions = asArray(triageOut?.actions).map((a) => asObject(a));

  const byProject = new Map<string, Record<string, unknown>[]>();
  for (const r of fleetRuns) {
    const key = String(r.project ?? "?");
    byProject.set(key, [...(byProject.get(key) ?? []), r]);
  }

  return (
    <>
      <div style={S.sub}>Fleet snapshot {pollOut ? `— ${String(pollOut.summary ?? "")}` : "(waiting for first sweep…)"}</div>
      {[...byProject.entries()].map(([project, runs]) => (
        <div key={project} style={S.card}>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>{project}</div>
          {runs.map((r) => {
            const id = String(r.runId ?? "?");
            const bucket = bucketOf(id);
            const color = bucket === "unclassified" ? "#8a8a8e" : healthColor(bucket);
            return (
              <div key={id} style={{ display: "flex", gap: 10, alignItems: "center", padding: "3px 0" }}>
                <span style={{ ...S.mono, flex: 1 }}>{id}</span>
                <span style={{ fontSize: 11, color: "#8a8a8e" }}>{String(r.lastEvent ?? "")}</span>
                <span style={S.chip(statusColor(String(r.status)))}>{String(r.status ?? "?")}</span>
                <span style={S.chip(color)}>{bucket}</span>
              </div>
            );
          })}
        </div>
      ))}
      {actions.length > 0 ? (
        <>
          <div style={S.sub}>Escalations</div>
          {actions.map((a, i) => (
            <div key={i} style={{ ...S.card, borderColor: "#f5b83d55" }}>
              <div style={S.mono}>{String(a.project ?? "")} / {String(a.runId ?? "")}</div>
              <div style={{ color: "#f5b83d", margin: "4px 0" }}>{String(a.problem ?? "")}</div>
              <div style={{ color: "#bbb" }}>{String(a.recommendedAction ?? "")}</div>
            </div>
          ))}
        </>
      ) : null}
    </>
  );
}

function App() {
  const [iterations, setIterations] = useState(12);
  const [intervalMinutes, setIntervalMinutes] = useState(5);
  const [busy, setBusy] = useState(false);
  const actions = useGatewayActions();

  const runsQuery = useGatewayRuns({ filter: { limit: 50 } });
  const allRuns = (runsQuery.data ?? []) as Run[];
  const monitorRuns = allRuns.filter((r) => r.workflowKey === WORKFLOW_KEY);
  const urlRunId = typeof location === "undefined" ? undefined : (new URLSearchParams(location.search).get("runId") ?? undefined);
  const activeRunId =
    urlRunId ??
    monitorRuns.find((r) => r.status === "running" || r.status === "continued")?.runId ??
    monitorRuns[0]?.runId;

  const approvalsQuery = useGatewayApprovals();
  const approvals = approvalsQuery.data ?? [];

  async function startWatch() {
    setBusy(true);
    try {
      await actions.launchRun({ workflow: WORKFLOW_KEY, input: { iterations, intervalMinutes } });
      await runsQuery.refetch?.();
    } finally {
      setBusy(false);
    }
  }
  async function decide(a: { runId: string; nodeId: string; iteration: number }, approved: boolean) {
    await actions.submitApproval({ runId: a.runId, nodeId: a.nodeId, iteration: a.iteration, decision: { approved } });
    await approvalsQuery.refetch?.();
  }

  return (
    <main style={S.page}>
      <h2 style={S.h}>Smithers fleet monitor</h2>

      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 4 }}>
        <label style={{ fontSize: 12, color: "#8a8a8e" }}>sweeps</label>
        <input style={S.input} type="number" min={1} value={iterations} onChange={(e) => setIterations(Number(e.currentTarget.value) || 1)} />
        <label style={{ fontSize: 12, color: "#8a8a8e" }}>every (min)</label>
        <input style={S.input} type="number" min={1} value={intervalMinutes} onChange={(e) => setIntervalMinutes(Number(e.currentTarget.value) || 1)} />
        <button style={{ ...S.btn, borderColor: "#5e6ad2", background: "#5e6ad2", color: "#fff" }} disabled={busy} onClick={() => void startWatch()}>
          Start watchdog
        </button>
        {activeRunId ? <span style={{ ...S.mono, color: "#8a8a8e" }}>watching {activeRunId}</span> : null}
      </div>

      {approvals.length > 0 ? (
        <>
          <div style={S.sub}>Pending approvals ({approvals.length})</div>
          {approvals.map((a) => (
            <div key={`${a.runId}:${a.nodeId}:${a.iteration}`} style={{ ...S.card, borderColor: "#5e6ad255" }}>
              <div style={{ fontWeight: 600 }}>{a.requestTitle ?? a.nodeId}</div>
              <div style={{ ...S.mono, color: "#8a8a8e", margin: "2px 0 6px" }}>{a.runId} · {a.nodeId}</div>
              {a.requestSummary ? <pre style={{ whiteSpace: "pre-wrap", fontSize: 12, color: "#bbb", margin: "0 0 8px" }}>{a.requestSummary}</pre> : null}
              <div style={{ display: "flex", gap: 8 }}>
                <button style={{ ...S.btn, borderColor: "#3ecf8e", color: "#3ecf8e" }} onClick={() => void decide(a, true)}>Approve</button>
                <button style={{ ...S.btn, borderColor: "#ff6369", color: "#ff6369" }} onClick={() => void decide(a, false)}>Deny</button>
              </div>
            </div>
          ))}
        </>
      ) : null}

      <div style={S.sub}>Runs in this gateway ({allRuns.length})</div>
      {allRuns.map((r) => (
        <div key={r.runId} style={{ ...S.card, display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 12px" }}>
          <span style={S.mono}>{r.runId}</span>
          <span style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <span style={{ fontSize: 11, color: "#8a8a8e" }}>{r.workflowKey ?? ""}</span>
            <span style={S.chip(statusColor(r.status))}>{r.status ?? "running"}</span>
          </span>
        </div>
      ))}

      {activeRunId ? <FleetPanel runId={activeRunId} /> : <div style={{ color: "#888", padding: 24 }}>No watchdog run yet — start one above.</div>}
    </main>
  );
}

createGatewayReactRoot(<App />);
