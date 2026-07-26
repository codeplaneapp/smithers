/** @jsxImportSource react */
import { createGatewayReactRoot, useGatewayNodeOutput, useGatewayRunEvents } from "smithers-orchestrator/gateway-react";
import { WorkflowUiStyles } from "smithers-orchestrator/gateway-ui";

const GATED_NODE_ID = "gated-task";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function runIdFromUrl(): string | undefined {
  if (typeof location === "undefined") return undefined;
  return new URLSearchParams(location.search).get("runId") ?? undefined;
}

function extractMarker(value: unknown): string {
  const response = isRecord(value) ? value : {};
  const data = isRecord(response.data) ? response.data : response;
  const row = isRecord(data.row) ? data.row : isRecord(data) ? data : {};
  return asString(row.marker);
}

const styles = [
  ":root { color-scheme:dark; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif; --bg:#101113; --panel:#181a1d; --text:#f3f4f6; --muted:#a1a1aa; --border:#2b2f36; --ok:#22c55e; --warn:#f59e0b; }",
  "* { box-sizing:border-box; }",
  "body { margin:0; background:var(--bg); color:var(--text); font-size:13px; }",
  ".shell { min-height:100vh; padding:20px; display:grid; gap:14px; align-content:start; }",
  ".head { display:flex; align-items:center; justify-content:space-between; gap:12px; }",
  "h1 { margin:0; font-size:15px; font-weight:650; }",
  ".pill { border:1px solid var(--border); border-radius:6px; padding:4px 8px; color:var(--muted); font-family:ui-monospace,monospace; }",
  ".panel { border:1px solid var(--border); border-radius:8px; background:var(--panel); padding:16px; display:grid; gap:10px; }",
  ".label { color:var(--muted); font-size:11px; text-transform:uppercase; letter-spacing:.04em; }",
  ".marker { white-space:pre-wrap; line-height:1.5; font-size:15px; }",
  ".ok { color:var(--ok); }",
  ".pending { color:var(--warn); }",
].join("\n");

function App() {
  const runId = runIdFromUrl();
  const stream = useGatewayRunEvents(runId, { afterSeq: 0 });
  const output = useGatewayNodeOutput({
    runId,
    nodeId: GATED_NODE_ID,
    iteration: 0,
  });
  const marker = extractMarker(output.data);
  const eventCount = stream.events.length;
  const status = marker ? "finished" : eventCount > 0 ? "waiting-approval" : "starting";

  return (
    <main className="shell">
      <style>{styles}</style>
      <WorkflowUiStyles mode="theme" />
      <div className="head">
        <h1>E2E Approval Probe</h1>
        <span className="pill" data-testid="approval-probe-run-id">
          {runId ?? ""}
        </span>
      </div>
      <section className="panel">
        <span className="label">Status</span>
        <strong className={marker ? "ok" : "pending"} data-testid="approval-probe-status">
          {status}
        </strong>
        <span className="label">Run events</span>
        <span data-testid="approval-probe-event-count">{eventCount}</span>
        <span className="label">Gated output</span>
        <div className="marker" data-testid="approval-probe-output">
          {marker}
        </div>
      </section>
    </main>
  );
}

createGatewayReactRoot(<App />);
