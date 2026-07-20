/** @jsxImportSource react */
// The reference "good" UI the ui-functional verifier should pass on every check.
// Doubles as a worked example: status + live event stream from every task +
// node output + failed-node surfacing + a working approval control. Kept
// dependency-free (inline styles) so it bundles anywhere the fixture runs.
import type { CSSProperties } from "react";
import {
  createGatewayReactRoot,
  useGatewayActions,
  useGatewayApprovals,
  useGatewayNodeOutput,
  useGatewayRun,
  useGatewayRunEvents,
} from "smithers-orchestrator/gateway-react";

function runIdFromUrl(): string | undefined {
  if (typeof location === "undefined") return undefined;
  return new URLSearchParams(location.search).get("runId") ?? undefined;
}

function rowOf(data: unknown): Record<string, unknown> {
  const d = (data ?? {}) as Record<string, unknown>;
  const inner = (d.row ?? d.data ?? d) as Record<string, unknown>;
  return (inner.row as Record<string, unknown>) ?? inner ?? {};
}

function App() {
  const runId = runIdFromUrl();
  const run = useGatewayRun(runId);
  const { events, streaming } = useGatewayRunEvents(runId, { afterSeq: 0 });
  const report = useGatewayNodeOutput({ runId, nodeId: "report", iteration: 0 });
  const approvals = useGatewayApprovals({ filter: { runId } });
  const { submitApproval } = useGatewayActions();

  if (!runId) return <main style={S.shell}>No runId in the URL. Append ?runId=…</main>;

  const status = String(run.data?.status ?? (run.loading ? "loading" : "unknown"));
  const reportRow = rowOf(report.data);
  // useGatewayApprovals().data IS the pending-approval array (GatewayApprovalSummary[]).
  const pending = approvals.data ?? [];
  // Node-level view derived from the live event stream, so every task (including
  // the failed one) is surfaced with its state. Event frames are
  // { event: "NodeStarted" | "NodeFinished" | "NodeFailed" | …, payload: { nodeId, error, … } }.
  const nodeState = new Map<string, string>();
  const nodeError = new Map<string, string>();
  for (const frame of events) {
    const name = String(frame.event ?? "");
    const payload = (frame.payload ?? {}) as Record<string, unknown>;
    const nodeId = String(payload.nodeId ?? "");
    if (!nodeId) continue;
    if (name === "NodeFailed") {
      nodeState.set(nodeId, "failed");
      const err = payload.error as { message?: string } | string | undefined;
      const msg = typeof err === "string" ? err : (err?.message ?? "");
      if (msg) nodeError.set(nodeId, msg);
    } else if (name === "NodeFinished") {
      if (nodeState.get(nodeId) !== "failed") nodeState.set(nodeId, "done");
    } else if (name === "NodeStarted" || name === "NodePending") {
      if (!nodeState.has(nodeId)) nodeState.set(nodeId, name === "NodeStarted" ? "running" : "pending");
    }
  }

  return (
    <main style={S.shell} data-testid="ui-eval-fixture-ui">
      <style>{":root{color-scheme:light dark}"}</style>
      <header style={S.head}>
        <h1 style={S.h1}>Release Dashboard</h1>
        <span style={S.pill} data-testid="run-status">
          {status} {streaming ? "· live" : ""}
        </span>
      </header>

      {run.error ? <div style={S.err}>Failed to load run: {String(run.error)}</div> : null}

      <section style={S.panel} data-testid="tasks">
        <div style={S.label}>Tasks</div>
        {[...nodeState.entries()].map(([nodeId, st]) => (
          <div key={nodeId} style={S.row}>
            <strong>{nodeId}</strong>
            <span style={st === "failed" ? S.bad : st === "done" ? S.ok : S.warn}>{st}</span>
            {nodeError.get(nodeId) ? <span style={S.errText}>{nodeError.get(nodeId)}</span> : null}
          </div>
        ))}
      </section>

      <section style={S.panel} data-testid="events">
        <div style={S.label}>Live events ({events.length})</div>
        <ul style={S.list}>
          {events.slice(-20).map((frame, i) => {
            const payload = (frame.payload ?? {}) as Record<string, unknown>;
            return (
              <li key={i}>
                {String(frame.event ?? "event")} {String(payload.nodeId ?? "")}
              </li>
            );
          })}
        </ul>
      </section>

      <section style={S.panel} data-testid="report">
        <div style={S.label}>Report</div>
        {report.loading ? (
          <div>Loading…</div>
        ) : reportRow.headline ? (
          <div>
            <strong>{String(reportRow.headline)}</strong>
            <p>{String(reportRow.summary ?? "")}</p>
          </div>
        ) : (
          <div>No report yet.</div>
        )}
      </section>

      <section style={S.panel} data-testid="approvals">
        <div style={S.label}>Approvals</div>
        {pending.length === 0 ? (
          <div>No pending approvals.</div>
        ) : (
          pending.map((a) => (
            <div key={a.nodeId} style={S.row}>
              <span>{a.requestTitle ?? a.requestSummary ?? a.nodeId}</span>
              <button
                type="button"
                style={S.btn}
                data-testid="approve"
                onClick={() =>
                  submitApproval({ runId, nodeId: a.nodeId, iteration: a.iteration, approved: true, decision: { approved: true } })
                }
              >
                Approve
              </button>
              <button
                type="button"
                style={S.btnGhost}
                onClick={() =>
                  submitApproval({ runId, nodeId: a.nodeId, iteration: a.iteration, approved: false, decision: { approved: false } })
                }
              >
                Deny
              </button>
            </div>
          ))
        )}
      </section>
    </main>
  );
}

const S: Record<string, CSSProperties> = {
  shell: { fontFamily: "system-ui, sans-serif", maxWidth: 720, margin: "0 auto", padding: 20, display: "grid", gap: 14 },
  head: { display: "flex", justifyContent: "space-between", alignItems: "center" },
  h1: { fontSize: 18, margin: 0 },
  pill: { fontFamily: "ui-monospace, monospace", border: "1px solid #8884", borderRadius: 6, padding: "3px 8px" },
  panel: { border: "1px solid #8883", borderRadius: 8, padding: 14, display: "grid", gap: 8 },
  label: { fontSize: 11, textTransform: "uppercase", letterSpacing: ".05em", opacity: 0.6 },
  row: { display: "flex", gap: 10, alignItems: "center" },
  list: { margin: 0, paddingLeft: 18, fontFamily: "ui-monospace, monospace", fontSize: 12 },
  ok: { color: "#16a34a" },
  warn: { color: "#d97706" },
  bad: { color: "#dc2626" },
  errText: { color: "#dc2626", fontSize: 12 },
  err: { color: "#dc2626", border: "1px solid #dc2626", borderRadius: 8, padding: 10 },
  btn: { padding: "4px 12px", borderRadius: 6, border: "1px solid #16a34a", background: "#16a34a", color: "#fff" },
  btnGhost: { padding: "4px 12px", borderRadius: 6, border: "1px solid #8884", background: "transparent" },
};

createGatewayReactRoot(<App />);
