/** @jsxImportSource react */
import { useMemo, useState } from "react";
import {
  createGatewayReactRoot,
  useGatewayActions,
  useGatewayNodeOutput,
  useGatewayRun,
  useGatewayRuns,
} from "smthrs/gateway-react";
import { WorkflowUiStyles } from "smthrs/gateway-ui";

const WORKFLOW_KEY = "telegram-daily-digest";

type Run = { runId: string; workflowKey?: string; status?: string; createdAtMs?: number };
type OutputData = {
  status?: string;
  source?: string;
  messageCount?: number;
  range?: string;
  reportPath?: string | null;
  posted?: boolean;
  acknowledged?: boolean;
  summary?: string;
  topics?: string[];
  warnings?: string[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function shortId(id: string): string {
  return id.slice(0, 8);
}

function extractOutput(value: unknown): OutputData | null {
  if (!isRecord(value)) return null;
  const candidate = isRecord(value.row) ? value.row : value;
  return isRecord(candidate) ? (candidate as OutputData) : null;
}

function asText(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (!isRecord(value)) return null;
  const row = isRecord(value.row) ? value.row : value;
  if (typeof row.markdown === "string") return row.markdown;
  return null;
}

function App() {
  const [selectedRunId, setSelectedRunId] = useState<string | undefined>(undefined);
  const [transcript, setTranscript] = useState("");
  const [busy, setBusy] = useState(false);
  const runsQuery = useGatewayRuns({ filter: { limit: 30 } });
  const actions = useGatewayActions();
  const runs = useMemo(
    () =>
      ((runsQuery.data ?? []) as Run[]).filter(
        (run) => !run.workflowKey || run.workflowKey === WORKFLOW_KEY,
      ),
    [runsQuery.data],
  );
  const activeRunId = selectedRunId ?? runs[0]?.runId;
  const runQuery = useGatewayRun(activeRunId);
  const outputQuery = useGatewayNodeOutput({ runId: activeRunId, nodeId: "output", iteration: 0 });
  const reportQuery = useGatewayNodeOutput({ runId: activeRunId, nodeId: "write-report", iteration: 0 });
  const output = useMemo(() => extractOutput(outputQuery.data), [outputQuery.data]);
  const report = useMemo(() => asText(reportQuery.data), [reportQuery.data]);
  const status = (isRecord(runQuery.data) && typeof runQuery.data.status === "string" ? runQuery.data.status : null) ?? output?.status;

  async function refresh() {
    await Promise.all([runsQuery.refetch(), runQuery.refetch?.(), outputQuery.refetch(), reportQuery.refetch()]);
  }

  async function launch() {
    setBusy(true);
    try {
      const input = transcript.trim()
        ? { source: "text", transcript, dryRun: true }
        : { source: "auto", dryRun: true };
      const run = await actions.launchRun({ workflow: WORKFLOW_KEY, input });
      setSelectedRunId(run.runId);
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="shell">
      <style>{styles}</style>
      <WorkflowUiStyles mode="theme" />
      <header className="topbar">
        <div>
          <h1>Telegram Daily Digest</h1>
          <div className="meta">{activeRunId ? shortId(activeRunId) : "No run"}</div>
        </div>
        <div className="toolbar">
          <button onClick={() => void refresh()} disabled={busy}>
            Refresh
          </button>
          <button className="primary" onClick={() => void launch()} disabled={busy}>
            Start
          </button>
        </div>
      </header>
      <section className="layout">
        <aside className="panel runs">
          <h2>Runs</h2>
          {runs.length === 0 ? (
            <div className="empty">No runs yet.</div>
          ) : (
            runs.map((run) => (
              <button
                key={run.runId}
                className={run.runId === activeRunId ? "run active" : "run"}
                onClick={() => setSelectedRunId(run.runId)}
              >
                <span>{shortId(run.runId)}</span>
                <small>{run.status ?? "running"}</small>
              </button>
            ))
          )}
        </aside>
        <section className="panel main">
          <div className="stats">
            <div className="stat">
              <strong>{output?.messageCount ?? 0}</strong>
              <span>Messages</span>
            </div>
            <div className="stat">
              <strong>{output?.source ?? "-"}</strong>
              <span>Source</span>
            </div>
            <div className="stat">
              <strong>{status ?? "-"}</strong>
              <span>Status</span>
            </div>
          </div>
          <textarea
            value={transcript}
            onChange={(event) => setTranscript(event.currentTarget.value)}
            placeholder="Paste a Telegram transcript for a dry run."
          />
          <div className="digest">
            <h2>Summary</h2>
            {output ? (
              <>
                <p>{output.summary || "No summary yet."}</p>
                {output.topics?.length ? (
                  <ul>
                    {output.topics.map((topic) => (
                      <li key={topic}>{topic}</li>
                    ))}
                  </ul>
                ) : null}
                {output.warnings?.length ? (
                  <div className="warnings">
                    {output.warnings.map((warning) => (
                      <div key={warning}>{warning}</div>
                    ))}
                  </div>
                ) : null}
              </>
            ) : (
              <div className="empty">Select or start a run.</div>
            )}
          </div>
          {report ? (
            <div className="report">
              <h2>Report</h2>
              <pre>{report}</pre>
            </div>
          ) : null}
        </section>
      </section>
    </main>
  );
}

const styles = `
  .shell {
    min-height: 100vh;
    background: #f6f7f4;
    color: #20231f;
    font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    letter-spacing: 0;
    padding: 20px;
  }
  .topbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    max-width: 1180px;
    margin: 0 auto 16px;
  }
  h1 { margin: 0; font-size: 22px; line-height: 1.1; }
  h2 { margin: 0 0 12px; font-size: 13px; text-transform: uppercase; color: #687066; }
  .meta, small { color: #687066; font-size: 12px; }
  .toolbar { display: flex; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }
  button {
    min-height: 36px;
    border: 1px solid #dfe3dc;
    border-radius: 6px;
    background: #fff;
    color: #20231f;
    padding: 0 12px;
    cursor: pointer;
    font: inherit;
    letter-spacing: 0;
  }
  button.primary { background: #1f7a4d; border-color: #1f7a4d; color: #fff; }
  button:disabled { opacity: 0.55; cursor: default; }
  .layout {
    max-width: 1180px;
    margin: 0 auto;
    display: grid;
    grid-template-columns: 260px 1fr;
    gap: 16px;
    align-items: start;
  }
  .panel {
    background: #fff;
    border: 1px solid #dfe3dc;
    border-radius: 8px;
    box-shadow: 0 10px 30px rgba(31, 38, 32, 0.08);
    padding: 16px;
  }
  .runs { display: grid; gap: 8px; }
  .run {
    width: 100%;
    display: flex;
    justify-content: space-between;
    align-items: center;
    text-align: left;
    background: #fbfcfa;
  }
  .run.active { border-color: #1f7a4d; box-shadow: inset 0 0 0 1px #1f7a4d; }
  .stats {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 10px;
    margin-bottom: 12px;
  }
  .stat {
    min-height: 74px;
    border: 1px solid #dfe3dc;
    border-radius: 8px;
    padding: 12px;
    background: #fbfcfa;
    overflow: hidden;
  }
  .stat strong {
    display: block;
    font-size: 20px;
    line-height: 1.15;
    margin-bottom: 6px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .stat span { color: #687066; font-size: 12px; }
  textarea {
    width: 100%;
    min-height: 120px;
    resize: vertical;
    border: 1px solid #dfe3dc;
    border-radius: 8px;
    padding: 10px;
    font: inherit;
    letter-spacing: 0;
    margin-bottom: 16px;
  }
  .digest p { line-height: 1.55; margin: 0 0 12px; }
  .empty {
    min-height: 120px;
    display: grid;
    place-items: center;
    border: 1px dashed #dfe3dc;
    border-radius: 8px;
    color: #687066;
    background: #fbfcfa;
  }
  .warnings {
    display: grid;
    gap: 6px;
    margin-top: 12px;
    color: #a06012;
    font-size: 13px;
  }
  .report { margin-top: 18px; }
  pre {
    max-height: 380px;
    overflow: auto;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    border: 1px solid #dfe3dc;
    border-radius: 8px;
    background: #f3f5f1;
    padding: 12px;
    font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  }
  @media (max-width: 800px) {
    .shell { padding: 12px; }
    .topbar { align-items: flex-start; flex-direction: column; }
    .toolbar { width: 100%; justify-content: stretch; }
    .toolbar button { flex: 1 1 120px; }
    .layout { grid-template-columns: 1fr; }
    .stats { grid-template-columns: 1fr; }
  }
`;

createGatewayReactRoot(<App />);
