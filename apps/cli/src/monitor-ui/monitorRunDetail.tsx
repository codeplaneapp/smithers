/** @jsxImportSource react */
import { useEffect, useRef, useState } from "react";
import {
  useGatewayActions,
  useGatewayRun,
  useGatewayWorkflows,
} from "smithers-orchestrator/gateway-react";
import { Button } from "smithers-orchestrator/ui";
import {
  asNumber,
  asString,
  isCancellable,
  isPausable,
  isRecord,
  isResumable,
  labelForStatus,
  pick,
  quotaInfoOf,
  runProgress,
  shortRunId,
} from "./monitorModel.ts";
import { Chip, RunLifecycleControls } from "./monitorShell.tsx";
import { EventLog } from "./monitorEventLog.tsx";
import { ExecutionPanel, type TreeNode } from "./monitorExecution.tsx";
import { HealthStrip } from "./monitorHealth.tsx";
import { ScoresPanel, type RunScores } from "./monitorScores.tsx";
import { FootprintPanel } from "./monitorFootprint.tsx";
import { DecisionsPanel } from "./monitorDecisions.tsx";
import { Elapsed, StatusTag } from "./monitorShared.tsx";
import { RunCostCard } from "./monitorUsagePanels.tsx";
import { RunEtaLine } from "./monitorEta.tsx";
import { RecapPanel } from "./monitorRecapPanel.tsx";

function CopyableRunId({ runId }: { runId: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  return (
    <button
      type="button"
      className="mon-runid"
      title="Copy run id"
      onClick={() => {
        void navigator.clipboard?.writeText(runId).then(() => {
          setCopied(true);
          if (timer.current) clearTimeout(timer.current);
          timer.current = setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      {runId}
      <span className="mon-dim">{copied ? " copied" : ""}</span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Run detail (header + lifecycle actions + tree + events).
// ---------------------------------------------------------------------------

export function RunDetail({
  runId,
  scores,
  onResult,
  selectedNode,
  onSelectNode,
  autoSelectNodeId,
  onAutoSelected,
}: {
  runId: string;
  scores: RunScores;
  onResult: (kind: "ok" | "err", text: string) => void;
  selectedNode: TreeNode | undefined;
  onSelectNode: (node: TreeNode | undefined) => void;
  autoSelectNodeId?: string;
  onAutoSelected?: () => void;
}) {
  const runQuery = useGatewayRun(runId);
  const actions = useGatewayActions();
  // The monitor is an operator surface: system workflows' runs show here too,
  // so their UI lookup (Open UI / Create UI) must see them.
  const workflowsQuery = useGatewayWorkflows({ filter: { includeSystem: true } });
  const [busyAction, setBusyAction] = useState<"cancel" | "resume" | "pause" | null>(null);
  const [showCustomUi, setShowCustomUi] = useState(false);
  const [creatingUi, setCreatingUi] = useState(false);
  const [footprintFocusNodeId, setFootprintFocusNodeId] = useState<string | undefined>();
  const customUiDialogRef = useRef<HTMLDivElement | null>(null);
  const customUiReturnFocusRef = useRef<HTMLElement | null>(null);
  const workflowsRefetch = workflowsQuery.refetch;
  const closeCustomUi = () => {
    setShowCustomUi(false);
    queueMicrotask(() => customUiReturnFocusRef.current?.focus());
  };
  useEffect(() => {
    if (!showCustomUi) return;
    customUiDialogRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeCustomUi();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [showCustomUi]);
  // While a create-ui run is authoring this workflow's UI, poll the workflow
  // list so the Open UI button appears the moment the file lands (the gateway
  // resolves .smithers/ui/<key>.tsx by convention with no restart).
  useEffect(() => {
    if (!creatingUi) return;
    const timer = setInterval(() => {
      void workflowsRefetch();
    }, 8_000);
    return () => clearInterval(timer);
  }, [creatingUi, workflowsRefetch]);

  const run = isRecord(runQuery.data) ? runQuery.data : null;

  if (!run && runQuery.loading) return <div className="mon-empty">Loading run…</div>;
  if (!run) {
    return (
      <div className="mon-empty" data-testid="monitor-run-missing">
        <div>Run not found.</div>
        <div className="mon-dim mon-mono">{runId}</div>
      </div>
    );
  }

  const status = asString(run.status);
  const workflowKey = asString(run.workflowKey) ?? "unknown";
  const startedAtMs = asNumber(pick(run, "startedAtMs", "started_at_ms")) ?? asNumber(pick(run, "createdAtMs", "created_at_ms"));
  const finishedAtMs = asNumber(pick(run, "finishedAtMs", "finished_at_ms"));
  const runState = isRecord(run.runState) ? run.runState : null;
  const healthState = runState ? asString(runState.state) : undefined;
  const quota = quotaInfoOf(run);
  const workflowRows = (Array.isArray(workflowsQuery.data) ? workflowsQuery.data : []).filter(isRecord);
  const workflowRow = workflowRows.find((row) => asString(row.key) === workflowKey);
  const customUiPath = workflowRow && workflowRow.hasUi === true ? asString(workflowRow.uiPath) : undefined;
  const customUiUrl = customUiPath ? `${customUiPath}?runId=${encodeURIComponent(runId)}` : undefined;
  const unhealthy =
    healthState !== undefined &&
    healthState !== labelForStatus(status) &&
    (healthState === "stale" || healthState === "orphaned" || healthState === "recovering");
  const progress = runProgress(run.summary);

  const act = async (kind: "cancel" | "resume" | "pause") => {
    setBusyAction(kind);
    try {
      if (kind === "cancel") {
        await actions.cancelRun({ runId });
        onResult("ok", `Cancel requested for ${shortRunId(runId)}. The row updates when the engine confirms.`);
      } else if (kind === "pause") {
        // The gateway's pauseRun RPC (POST /v1/api/runs/:id/pause) is a
        // durable request: the engine stops scheduling, drains in-flight
        // tasks, then parks the run resumably. Not exposed on the actions
        // API, so call the REST route directly.
        const response = await fetch(`/v1/api/runs/${encodeURIComponent(runId)}/pause`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        });
        const body: unknown = await response.json().catch(() => null);
        const envelope = isRecord(body) ? body : {};
        if (!response.ok || envelope.ok === false) {
          const error = isRecord(envelope.error) ? asString(envelope.error.message) : undefined;
          throw new Error(error ?? `pause failed (${response.status})`);
        }
        onResult("ok", `Pause requested for ${shortRunId(runId)} — in-flight tasks drain, then the run parks resumably.`);
      } else {
        await actions.resumeRun({ runId });
        onResult("ok", `Resume requested for ${shortRunId(runId)}.`);
      }
    } catch (error) {
      const verb = kind === "cancel" ? "Cancel" : kind === "pause" ? "Pause" : "Resume";
      onResult("err", `${verb} failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusyAction(null);
    }
  };

  return (
    <div className="mon-detail" data-testid="monitor-run-detail">
      <HealthStrip runId={runId} status={status} healthState={healthState} quota={quota} />

      <header className="mon-detail-head mon-detail-header-band mon-panel">
        <div className="mon-detail-title">
          <StatusTag status={status} />
          {unhealthy ? <StatusTag status={healthState} label={healthState} /> : null}
          <span className="mon-detail-workflow">{workflowKey}</span>
          <span className="mon-dim">
            <Elapsed startMs={startedAtMs} endMs={finishedAtMs} />
          </span>
        </div>
        <CopyableRunId runId={runId} />
        {progress ? (
          <div className="mon-progress" title={`${progress.done} done · ${progress.failed} failed · ${progress.total} nodes`}>
            <div className="mon-progress-track">
              <div className="mon-progress-fill" style={{ width: `${Math.round(progress.fraction * 100)}%` }} />
            </div>
            <span className="mon-dim mon-mono">
              {progress.done + progress.failed}/{progress.total}
              {progress.failed > 0 ? ` · ${progress.failed} failed` : ""}
            </span>
          </div>
        ) : null}
        <div className="mon-detail-cost-eta">
          <RunCostCard runId={runId} active={status === "running" || status === "pending"} progressRatio={progress?.fraction} />
          <RunEtaLine runId={runId} runStatus={status} startedAtMs={startedAtMs} finishedAtMs={finishedAtMs} />
        </div>
        <div className="mon-detail-actions">
          {customUiUrl ? (
            <Button
              variant="outline"
              onClick={() => {
                customUiReturnFocusRef.current = document.activeElement as HTMLElement | null;
                setShowCustomUi(true);
              }}
              title={`Open this workflow's custom UI (${customUiPath})`}
            >
              Open UI
            </Button>
          ) : workflowRow && workflowKey !== "create-ui" ? (
            <Button
              variant="outline"
              disabled={creatingUi}
              title="Launch the create-ui workflow: one agent writes .smithers/ui/<key>.tsx and verifies it against this gateway"
              onClick={() => {
                setCreatingUi(true);
                void actions
                  .launchRun({
                    workflow: "create-ui",
                    input: { targetWorkflow: workflowKey, gatewayUrl: location.origin, exampleRunId: runId },
                  })
                  .then(() => {
                    onResult("ok", `Creating a UI for ${workflowKey} — the Open UI button appears here when it's ready (a few minutes).`);
                  })
                  .catch((error) => {
                    setCreatingUi(false);
                    onResult("err", `Create UI failed to launch: ${error instanceof Error ? error.message : String(error)}`);
                  });
              }}
            >
              {creatingUi ? "Creating UI…" : "Create UI"}
            </Button>
          ) : null}
          <RunLifecycleControls
            runId={runId}
            resumable={isResumable(status)}
            pausable={isPausable(status)}
            cancellable={isCancellable(status)}
            busyAction={busyAction}
            onAction={(kind) => void act(kind)}
          />
        </div>
      </header>

      <RecapPanel runId={runId} status={status} />
      <DecisionsPanel runId={runId} runStatus={status} onSelectNode={onSelectNode} />
      <ScoresPanel scores={scores} />
      <FootprintPanel runId={runId} live={status === "running"} onFocusNode={setFootprintFocusNodeId} />

      {showCustomUi && customUiUrl ? (
        <div className="mon-modal-backdrop" onClick={closeCustomUi} data-testid="monitor-ui-modal">
          <div
            className="mon-modal"
            ref={customUiDialogRef}
            role="dialog"
            aria-modal="true"
            aria-label={`${workflowKey} custom UI`}
            tabIndex={-1}
            onClick={(event) => event.stopPropagation()}
          >
            <header className="mon-modal-head">
              <span className="mon-kicker">{workflowKey} UI</span>
              <Chip asChild>
                <a href={customUiUrl} target="_blank" rel="noreferrer">
                  Open in new tab
                </a>
              </Chip>
              <Chip onClick={closeCustomUi}>Close</Chip>
            </header>
            <iframe className="mon-modal-frame" src={customUiUrl} title={`${workflowKey} custom UI`} />
          </div>
        </div>
      ) : null}

      <ExecutionPanel
        runId={runId}
        runStatus={status}
        selectedNode={selectedNode}
        onSelectNode={onSelectNode}
        autoSelectNodeId={footprintFocusNodeId ?? autoSelectNodeId}
        onAutoSelected={() => { setFootprintFocusNodeId(undefined); onAutoSelected?.(); }}
      />

      <EventLog runId={runId} />
    </div>
  );
}
