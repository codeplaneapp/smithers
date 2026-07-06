/** @jsxImportSource react */
// Custom `smithers ui` for the delegation-chain workflow.
// Main surface: the live delegation tree (dc-graph). Side rail: phase-0
// question forms, the refined-prompt approval, the node inspector (editable
// outputs + version history), scores, and the end-of-run poll. Header: the
// run-level cost bar ("$actual of ~$latestPredicted") and phase indicator.
import { useMemo, useState } from "react";
import {
  createGatewayReactRoot,
  useDelegationChain,
  useGatewayActions,
  useGatewayApprovals,
  useGatewayRuns,
} from "smithers-orchestrator/gateway-react";
import { crepeThemeCss } from "./crepeTheme.generated";
import { xyflowThemeCss } from "./xyflowTheme.generated";
import { themeCss } from "./cw-theme";
import { DelegationGraphCanvas } from "./delegation-chain/dc-graph";
import { NodeInspector } from "./delegation-chain/dc-inspector";
import { PollForm, QuestionsPanel, RefinedPromptApproval } from "./delegation-chain/dc-questions";
import {
  BudgetBar,
  ErrorBanner,
  PhaseStrip,
  ScoresPanel,
  SkipPreviewsButton,
  dcCss,
  goalApprovalPendingOf,
  pollPendingOf,
  runIdFromUrl,
} from "./delegation-chain/dc-shared";

const WORKFLOW_KEY = "delegation-chain";

type RunSummary = { runId: string; workflowKey?: string; status?: string };

function shortRunId(runId: string | undefined): string {
  return runId ? runId.slice(0, 8) : "no run";
}
function statusClass(status: string | undefined): string {
  const value = (status ?? "").toLowerCase();
  if (["running", "continued", "queued", "pending"].includes(value)) return "warn";
  if (value === "finished") return "ok";
  if (["failed", "cancelled"].includes(value)) return "bad";
  return "info";
}

function App() {
  const [selectedRunId, setSelectedRunId] = useState<string | undefined>(runIdFromUrl());
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [launchError, setLaunchError] = useState<string | null>(null);
  const [pollSubmitted, setPollSubmitted] = useState(false);
  const [pollBusy, setPollBusy] = useState(false);
  const [pollError, setPollError] = useState<string | null>(null);

  const gatewayActions = useGatewayActions();
  const runsQuery = useGatewayRuns({ filter: { limit: 30 } });
  const runs = useMemo(
    () =>
      ((runsQuery.data ?? []) as RunSummary[]).filter(
        (run) => !run.workflowKey || run.workflowKey === WORKFLOW_KEY,
      ),
    [runsQuery.data],
  );
  const activeRunId = selectedRunId ?? runIdFromUrl() ?? runs[0]?.runId;
  const activeRun = runs.find((run) => run.runId === activeRunId);

  const { graph, loading, errors, actions } = useDelegationChain({ runId: activeRunId ?? "" });

  // Pending human approvals (physical node ids) for the active run: gates the
  // question forms (prefetched rows are not answerable until their HumanTask
  // mounts) — see QuestionsPanel.
  const approvalsQuery = useGatewayApprovals(activeRunId ? { filter: { runId: activeRunId } } : {});
  const pendingApprovalIds = useMemo(() => {
    const ids = new Set<string>();
    for (const approval of approvalsQuery.data ?? []) {
      if (!activeRunId || approval.runId !== activeRunId) continue;
      ids.add(approval.nodeId);
    }
    return ids;
  }, [approvalsQuery.data, activeRunId]);

  const selectedNode = selectedNodeId ? graph.nodes[selectedNodeId] : undefined;
  const unresolvedQuestions = useMemo(
    () => graph.pendingQuestions.filter((question) => !question.resolved),
    [graph.pendingQuestions],
  );
  // Renders whenever the goal approval is pending — including a degraded
  // agent's EMPTY refined prompt (the surface shows a warning instead of
  // leaving the paused run with nothing actionable).
  const showRefinedPrompt = goalApprovalPendingOf(graph);
  const showPoll = pollPendingOf(pendingApprovalIds) && !pollSubmitted;
  const nodeCount = Object.keys(graph.nodes).length;

  async function launch() {
    if (!prompt.trim()) return;
    setBusy(true);
    setLaunchError(null);
    try {
      const result = (await gatewayActions.launchRun({
        workflow: WORKFLOW_KEY,
        input: { prompt: prompt.trim() },
      })) as { runId?: string };
      if (result?.runId) setSelectedRunId(result.runId);
      await runsQuery.refetch();
    } catch (cause) {
      setLaunchError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function submitPoll(answers: Parameters<typeof actions.submitPoll>[0], comment?: string) {
    setPollBusy(true);
    setPollError(null);
    try {
      await actions.submitPoll(answers, comment);
      setPollSubmitted(true);
    } catch (cause) {
      setPollError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPollBusy(false);
    }
  }

  return (
    <main className="shell" data-testid="delegation-chain-ui">
      <style>{crepeThemeCss}</style>
      <style>{xyflowThemeCss}</style>
      <style>{themeCss}</style>
      <style>{dcCss}</style>
      <header className="top">
        <div className="title">
          <h1>Delegation Chain</h1>
          <span className="pill mono" data-testid="dc-runid">{shortRunId(activeRunId)}</span>
          {activeRun?.status ? (
            <span className={"badge " + statusClass(activeRun.status)} data-testid="dc-run-status">
              {activeRun.status}
            </span>
          ) : null}
          <BudgetBar budget={graph.budget} />
        </div>
        <div className="actions">
          <SkipPreviewsButton phase={graph.phase} actions={actions} />
          {runs.length > 0 ? (
            <select
              className="run-select"
              data-testid="dc-run-select"
              value={activeRunId ?? ""}
              onChange={(event) => {
                setSelectedRunId(event.currentTarget.value || undefined);
                setSelectedNodeId(null);
                setPollSubmitted(false);
              }}
            >
              {runs.map((run) => (
                <option key={run.runId} value={run.runId}>
                  {shortRunId(run.runId)} · {run.status ?? "unknown"}
                </option>
              ))}
            </select>
          ) : null}
          <input
            className="input prompt-input"
            data-testid="dc-prompt"
            value={prompt}
            onInput={(event) => setPrompt(event.currentTarget.value)}
            onChange={(event) => setPrompt(event.currentTarget.value)}
            placeholder="Describe the ambiguous ask to delegate..."
          />
          <button
            type="button"
            className="button primary"
            data-testid="dc-launch"
            disabled={busy || !prompt.trim()}
            onClick={() => void launch()}
          >
            {busy ? "Launching..." : "Delegate"}
          </button>
        </div>
      </header>
      <PhaseStrip phase={graph.phase} />
      {launchError ? <div className="error-strip">{launchError}</div> : null}
      {errors.length > 0 ? <ErrorBanner title="Gateway errors" errors={errors} /> : null}
      {!activeRunId ? (
        <div className="content">
          <div className="launch">
            <section className="launch-card" data-testid="dc-empty">
              <div className="pane-title">
                <span className="eyebrow">New delegation</span>
                <h2>Hand an ambiguous ask to a tiered delegation tree</h2>
                <p>
                  Fable refines the goal with a few questions, decomposes into opus chunks and
                  sonnet leaves, previews expected outputs, hunts risk with probes, then executes
                  behind gates. Every output stays editable while it runs.
                </p>
              </div>
              <textarea
                className="input"
                data-testid="dc-prompt-empty"
                value={prompt}
                onInput={(event) => setPrompt(event.currentTarget.value)}
                onChange={(event) => setPrompt(event.currentTarget.value)}
                placeholder="e.g. migrate plue to the smithers control plane"
              />
              <div className="launch-row">
                <button
                  type="button"
                  className="button primary"
                  data-testid="dc-launch-empty"
                  disabled={busy || !prompt.trim()}
                  onClick={() => void launch()}
                >
                  {busy ? "Launching..." : "Delegate"}
                </button>
              </div>
            </section>
          </div>
        </div>
      ) : (
        <div className="dc-main">
          <div className="dc-canvas" data-testid="dc-canvas">
            {nodeCount > 0 ? (
              <DelegationGraphCanvas graph={graph} selectedId={selectedNodeId} onSelect={setSelectedNodeId} />
            ) : (
              <div className="empty" data-testid="dc-canvas-empty">
                {loading ? "Loading run..." : "The delegation tree appears as the goal agent starts."}
              </div>
            )}
          </div>
          <aside className="dc-rail" data-testid="dc-rail">
            <QuestionsPanel
              questions={graph.pendingQuestions}
              actions={actions}
              pendingApprovalIds={pendingApprovalIds}
            />
            {showRefinedPrompt ? (
              <RefinedPromptApproval key={graph.refinedPrompt ?? ""} graph={graph} actions={actions} />
            ) : null}
            {selectedNode ? (
              <NodeInspector node={selectedNode} actions={actions} onClose={() => setSelectedNodeId(null)} />
            ) : null}
            <ScoresPanel scores={graph.scores} />
            {showPoll ? <PollForm busy={pollBusy} onSubmit={(answers, comment) => void submitPoll(answers, comment)} /> : null}
            {pollError ? <div className="error-strip">{pollError}</div> : null}
            {!selectedNode && unresolvedQuestions.length === 0 && !showRefinedPrompt && !showPoll && !graph.scores ? (
              <p className="muted" data-testid="dc-rail-empty">
                Click a node to inspect its brief, output (editable), gates, and version history.
                Pulsing ⚠ badges jump to whatever needs you.
              </p>
            ) : null}
          </aside>
        </div>
      )}
    </main>
  );
}

createGatewayReactRoot(<App />);
