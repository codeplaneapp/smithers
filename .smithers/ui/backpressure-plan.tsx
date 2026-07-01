/** @jsxImportSource react */
import { useState } from "react";
import { createGatewayReactRoot, useGatewayActions, useGatewayRuns } from "smithers-orchestrator/gateway-react";

const WORKFLOW_KEY = "backpressure-plan";

type Run = { runId: string; workflowKey?: string; status?: string; createdAtMs?: number };
function shortId(id: string) { return id.slice(0, 8); }

function App() {
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const runsRaw = useGatewayRuns({ filter: { limit: 20 } });
  const runs = ((runsRaw.data ?? []) as Run[]).filter((r) => !r.workflowKey || r.workflowKey === WORKFLOW_KEY);
  const actions = useGatewayActions();
  async function start() {
    setBusy(true);
    try { await actions.launchRun({ workflow: WORKFLOW_KEY, input: { prompt } }); }
    finally { setBusy(false); }
  }
  return (
    <main style={{ fontFamily: "-apple-system,BlinkMacSystemFont,sans-serif", fontSize: 13, background: "#0c0c0e", color: "#eee", minHeight: "100vh", padding: "20px" }}>
      <h2 style={{ fontSize: 14, fontWeight: 600, margin: "0 0 16px" }}>{WORKFLOW_KEY}</h2>
      <div style={{ display: "flex", gap: 8, marginBottom: 20 }}>
        <input style={{ flex: 1, padding: "6px 10px", border: "1px solid #333", borderRadius: 6, background: "#151518", color: "#eee", fontSize: 13 }} value={prompt} onChange={(e) => setPrompt(e.currentTarget.value)} placeholder="Optional prompt…" />
        <button style={{ padding: "6px 14px", border: "1px solid #5e6ad2", borderRadius: 6, background: "#5e6ad2", color: "#fff", cursor: "pointer" }} disabled={busy} onClick={() => void start()}>Start</button>
      </div>
      {runs.length === 0 ? (
        <div style={{ color: "#888", textAlign: "center", padding: 48 }}>No runs yet.</div>
      ) : (
        <ul style={{ margin: 0, padding: 0, listStyle: "none" }}>
          {runs.map((r) => (
            <li key={r.runId} style={{ display: "flex", justifyContent: "space-between", padding: "8px 12px", background: "#151518", border: "1px solid #262629", borderRadius: 8, marginBottom: 8 }}>
              <span style={{ fontFamily: "ui-monospace,monospace", fontSize: 12 }}>{shortId(r.runId)}</span>
              <span style={{ fontSize: 11, color: "#8a8a8e" }}>{r.status ?? "running"}</span>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}

createGatewayReactRoot(<App />);