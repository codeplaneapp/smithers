/** @jsxImportSource react */
import { useEffect, useMemo, useState } from "react";
import { useGatewayActions, useGatewayRuns } from "@smthrs/gateway-react";
import { RelativeTime } from "@smthrs/ui";
import { formatStatus, statusClass } from "./theme";
import { ConnectionBadge } from "./ConnectionBadge";
import { MonitorButton } from "./MonitorButton";
import { NodeChatStream } from "./NodeChatStream";
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

export function formatTime(ms: number | undefined): string {
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
  const [pendingRunId, setPendingRunId] = useState<string | undefined>();
  const [selectedNodeId, setSelectedNodeId] = useState<string | undefined>();
  const runsRaw = useGatewayRuns({ filter: { workflow, limit: runLimit } });
  const actions = useGatewayActions();
  const runs = useMemo(
    () =>
      ((runsRaw.data ?? []) as SimpleWorkflowRun[]).filter((run) => !run.workflowKey || run.workflowKey === workflow),
    [runsRaw.data, workflow],
  );
  const selectedRunPresent = selectedRunId ? runs.some((run) => run.runId === selectedRunId) : false;
  // A run launched from here is selected before the runs collection has synced
  // it in. Until it lands its absence must not read as a stale selection, or
  // the reconcile effect below would snap straight back to the previous top run.
  const awaitingLaunch = pendingRunId !== undefined && pendingRunId === selectedRunId && !selectedRunPresent;
  const activeRunId = selectedRunPresent || awaitingLaunch ? selectedRunId : runs[0]?.runId;

  useEffect(() => {
    if (pendingRunId !== undefined && runs.some((run) => run.runId === pendingRunId)) setPendingRunId(undefined);
    else if (runs.length > 0 && !selectedRunPresent && !awaitingLaunch) setSelectedRunId(runs[0]!.runId);
  }, [runs, selectedRunPresent, awaitingLaunch, pendingRunId]);

  // Reset the selected node when switching runs — a nodeId is only meaningful
  // within its own run.
  useEffect(() => {
    setSelectedNodeId(undefined);
  }, [activeRunId]);

  async function start() {
    setBusy(true);
    setError(null);
    try {
      const result = await actions.launchRun({ workflow, input: inputFromPrompt(prompt) });
      const runId = (result as { runId?: string } | undefined)?.runId;
      if (runId) {
        setSelectedRunId(runId);
        setPendingRunId(runId);
      }
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
      actions={
        <>
          <MonitorButton runId={activeRunId} />
          <ConnectionBadge className="chip" />
        </>
      }
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
                  <span className="workflow-run-meta">
                    {run.createdAtMs ? (
                      <RelativeTime ts={run.createdAtMs} title={new Date(run.createdAtMs).toLocaleString()} />
                    ) : (
                      workflow
                    )}
                  </span>
                </span>
                <span className={`badge ${statusClass(run.status)}`}>{formatStatus(run.status ?? "running")}</span>
              </button>
            ))
          )}
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 14, minWidth: 0 }}>
          <div className="workflow-detail" aria-label="Run detail">
            <div className="panel">
              <div className="section-head">
                <span>Nodes</span>
                {activeRunId ? <span className="mono">{shortRunId(activeRunId)}</span> : null}
              </div>
              <RunTree
                runId={activeRunId}
                className="workflow-tree"
                activeNodeId={selectedNodeId}
                onSelectNode={(node) => setSelectedNodeId(node.id)}
              />
            </div>
            <div className="panel">
              <div className="section-head">
                <span>Events</span>
                {activeRunId ? <span className="mono">{shortRunId(activeRunId)}</span> : null}
              </div>
              <RunEventLog
                runId={activeRunId}
                className="workflow-events"
                selectedNodeId={selectedNodeId}
                onSelectNode={setSelectedNodeId}
              />
            </div>
          </div>
          <div className="panel" aria-label="Node chat">
            <div className="section-head">
              <span>Chat</span>
              {selectedNodeId ? <span className="mono">{selectedNodeId}</span> : null}
            </div>
            <NodeChatStream runId={activeRunId} nodeId={selectedNodeId} height="auto" />
          </div>
        </div>
      </section>
    </WorkflowUiShell>
  );
}
