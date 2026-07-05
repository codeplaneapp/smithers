import { useEffect, useMemo, useState } from "react";
import { useGatewayActions, useGatewayRuns } from "@smithers-orchestrator/gateway-react";
import { formatStatus, statusClass } from "./theme";
import { ConnectionBadge } from "./ConnectionBadge";
import { RunEventLog } from "./RunEventLog";
import { RunTree } from "./RunTree";
import { WorkflowUiShell } from "./styleguide";

export type SimpleWorkflowRun = {
  runId: string;
  workflowKey?: string;
  status?: string;
  createdAtMs?: number;
};

export type SimpleWorkflowDashboardProps = {
  workflow: string;
  title?: string;
  promptPlaceholder?: string;
  initialPrompt?: string;
  inputFromPrompt?: (prompt: string) => Record<string, unknown>;
  runLimit?: number;
  testId?: string;
};

function shortRunId(runId: string): string {
  return runId.slice(0, 8);
}

function formatTime(ms: number | undefined): string {
  if (!ms) return "";
  try {
    return new Date(ms).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  } catch {
    return "";
  }
}

export function SimpleWorkflowDashboard({
  workflow,
  title = workflow,
  promptPlaceholder = "Optional prompt...",
  initialPrompt = "",
  inputFromPrompt = (prompt) => ({ prompt }),
  runLimit = 20,
  testId,
}: SimpleWorkflowDashboardProps) {
  const [prompt, setPrompt] = useState(initialPrompt);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | undefined>();
  const runsRaw = useGatewayRuns({ filter: { workflow, limit: runLimit } });
  const actions = useGatewayActions();
  const runs = useMemo(
    () => ((runsRaw.data ?? []) as SimpleWorkflowRun[]).filter((run) => !run.workflowKey || run.workflowKey === workflow),
    [runsRaw.data, workflow],
  );
  const selectedRunPresent = selectedRunId ? runs.some((run) => run.runId === selectedRunId) : false;
  const activeRunId = selectedRunPresent ? selectedRunId : runs[0]?.runId;

  useEffect(() => {
    if (runs.length > 0 && !selectedRunPresent) setSelectedRunId(runs[0]!.runId);
  }, [runs, selectedRunPresent]);

  async function start() {
    setBusy(true);
    setError(null);
    try {
      const result = await actions.launchRun({ workflow, input: inputFromPrompt(prompt) });
      const runId = (result as { runId?: string } | undefined)?.runId;
      if (runId) setSelectedRunId(runId);
      setPrompt("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <WorkflowUiShell
      title={title}
      testId={testId}
      meta={<span className="pill">{runs.length || (runsRaw.loading ? "..." : "0")} runs</span>}
      actions={<ConnectionBadge className="chip" />}
    >
      <section className="card">
        <div className="workflow-launch">
          <input
            className="input"
            value={prompt}
            onChange={(event) => setPrompt(event.currentTarget.value)}
            placeholder={promptPlaceholder}
            aria-label="Workflow prompt"
          />
          <button className="button primary" type="button" disabled={busy} onClick={() => void start()}>
            {busy ? "Starting..." : "Start"}
          </button>
        </div>
        {error ? <div className="alert err">{error}</div> : null}
      </section>

      <section className="workflow-dashboard">
        <div className="workflow-runs" aria-label="Runs">
          {runs.length === 0 ? (
            <div className="empty">{runsRaw.loading ? "Loading runs..." : "No runs yet."}</div>
          ) : (
            runs.map((run) => (
              <button
                className={`workflow-run-row${run.runId === activeRunId ? " active" : ""}`}
                type="button"
                key={run.runId}
                aria-pressed={run.runId === activeRunId}
                onClick={() => setSelectedRunId(run.runId)}
              >
                <span className="workflow-run-main">
                  <span className="workflow-run-id">{shortRunId(run.runId)}</span>
                  <span className="workflow-run-meta">{formatTime(run.createdAtMs) || workflow}</span>
                </span>
                <span className={`badge ${statusClass(run.status)}`}>{formatStatus(run.status ?? "running")}</span>
              </button>
            ))
          )}
        </div>
        <div className="workflow-detail" aria-label="Run detail">
          <div className="panel">
            <div className="section-head">
              <span>Nodes</span>
              {activeRunId ? <span className="mono">{shortRunId(activeRunId)}</span> : null}
            </div>
            <RunTree runId={activeRunId} className="workflow-tree" />
          </div>
          <div className="panel">
            <div className="section-head">
              <span>Events</span>
              {activeRunId ? <span className="mono">{shortRunId(activeRunId)}</span> : null}
            </div>
            <RunEventLog runId={activeRunId} className="workflow-events" />
          </div>
        </div>
      </section>
    </WorkflowUiShell>
  );
}
