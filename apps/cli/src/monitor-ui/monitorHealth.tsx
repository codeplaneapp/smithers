/** @jsxImportSource react */
import { useState } from "react";
import {
  useGatewayActions,
  useGatewayApprovals,
  useGatewayNodeOutput,
  useGatewayRunTree,
} from "smithers-orchestrator/gateway-react";
import { Button } from "smithers-orchestrator/ui";
import {
  asString,
  diagnoseRun,
  isRecord,
  nodeErrorOf,
  quotaInfoOf,
} from "./monitorModel.ts";
import { Countdown } from "./monitorShared.tsx";

// ---------------------------------------------------------------------------
// Health strip: one always-on green/yellow/red verdict per run — what it is
// doing right now and the concrete fix — recomputed live from gateway state.
// ---------------------------------------------------------------------------

export function HealthStrip({
  runId,
  status,
  healthState,
  quota,
}: {
  runId: string;
  status: string | undefined;
  healthState: string | undefined;
  quota: ReturnType<typeof quotaInfoOf>;
}) {
  const tree = useGatewayRunTree(runId);
  const approvalsQuery = useGatewayApprovals();
  const actions = useGatewayActions();
  const [resumeBusy, setResumeBusy] = useState(false);
  const [resumeNote, setResumeNote] = useState<string | null>(null);
  const requestResume = async () => {
    setResumeBusy(true);
    setResumeNote(null);
    try {
      const response = await actions.resumeRun({ runId });
      setResumeNote(
        response.status === "already_terminal"
          ? "Run already reached a terminal state."
          : "Resume requested — an engine is re-attaching.",
      );
    } catch (error) {
      setResumeNote(`Resume failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setResumeBusy(false);
    }
  };
  const treeNodes = tree.nodes ?? [];
  const approvalsCount = (Array.isArray(approvalsQuery.data) ? approvalsQuery.data : []).filter(
    (approval: unknown) => isRecord(approval) && approval.runId === runId,
  ).length;
  // One representative failure, so the strip can say WHY without a click.
  const failedTask = treeNodes.find(
    (node) => asString(node.status) === "failed" && !/^\d+$/.test(asString(node.id) ?? ""),
  );
  const failedNodeId = failedTask ? asString(failedTask.id) : undefined;
  const failedIteration = failedTask && typeof failedTask.iteration === "number" ? failedTask.iteration : 0;
  const sampleQuery = useGatewayNodeOutput({ runId, nodeId: failedNodeId, iteration: failedIteration });
  const sampleError = nodeErrorOf(sampleQuery.data);
  // First paint: the tree collection is still pulling — a verdict computed on
  // an empty tree ("no tasks yet") is wrong, not neutral. Say loading.
  if (tree.isLoading && treeNodes.length === 0) {
    return (
      <div className="mon-banner tone-waiting mon-health" data-testid="monitor-health-strip">
        <div className="mon-health-headline">
          <span className="mon-dot mon-dot-pulse" aria-hidden /> <b>Assessing run health…</b>
        </div>
      </div>
    );
  }
  const diagnosis = diagnoseRun({
    runId,
    status,
    healthState,
    quota,
    approvalsCount,
    treeNodes,
    failureSample: failedNodeId && sampleError ? { nodeId: failedNodeId, message: sampleError.message } : null,
  });
  const tone = diagnosis.tone === "ok" ? "tone-ok" : diagnosis.tone === "crit" ? "tone-failed" : "tone-waiting";
  return (
    <div className={`mon-banner ${tone} mon-health`} data-testid="monitor-health-strip">
      <div className="mon-health-headline">
        <span className={`mon-health-dot ${tone}`} />
        <b>{diagnosis.headline}</b>
        {status === "waiting-quota" && quota?.resetAtMs ? (
          <span>
            {" · resumes ~"}
            {new Date(quota.resetAtMs).toLocaleTimeString()} (<Countdown untilMs={quota.resetAtMs} />)
          </span>
        ) : null}
      </div>
      <div className="mon-health-detail">{diagnosis.detail}</div>
      {quota?.blocked.length ? (
        <ul className="mon-quota-list">
          {quota.blocked.map((entry) => (
            <li key={entry.nodeId}>
              <span className="mon-mono">{entry.nodeId}</span>
              {entry.message ? <span className="mon-dim"> — {entry.message}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
      <div className="mon-health-fix mon-dim">{diagnosis.fix}</div>
      {diagnosis.action === "resume" ? (
        <div className="mon-health-actions">
          <Button
            variant="outline"
            className="mon-btn-ok"
            data-testid="monitor-resume-run"
            disabled={resumeBusy}
            title="Ask the gateway to re-attach an engine and resume this run now"
            onClick={() => void requestResume()}
          >
            {resumeBusy ? "Resuming…" : "Resume now"}
          </Button>
          {resumeNote ? <span className="mon-dim">{resumeNote}</span> : null}
        </div>
      ) : null}
    </div>
  );
}
