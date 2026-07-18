/** @jsxImportSource react */
import { TableCell, TableRow } from "smithers-orchestrator/ui";
import { isRecord, runProgress, shortRunId, type RunRow } from "./monitorModel.ts";
import { Ago, Elapsed, StatusTag } from "./monitorShared.tsx";
import { RunEtaCell } from "./monitorEta.tsx";
import { failedTaskCountOf } from "./monitorAttentionModel.ts";
import { FailedTaskBadge } from "./monitorFailedBadge.tsx";

/** Compact `done+failed/total` from the optional RPC node-state summary. */
export function RunProgressCell({ run }: { run: RunRow }) {
  const progress = isRecord(run) ? runProgress(run.summary) : null;
  if (!progress) return <span className="mon-dim">—</span>;
  return (
    <span
      className="mon-mono"
      data-testid="monitor-run-progress"
      title={`${progress.done} done · ${progress.failed} failed · ${progress.total} nodes`}
    >
      {progress.done + progress.failed}/{progress.total}
      {progress.failed > 0 ? <span className="tone-failed mon-table-failed"> · {progress.failed} failed</span> : null}
    </span>
  );
}

export function RunsTableRow({ run, onSelect }: { run: RunRow; onSelect: (runId: string) => void }) {
  return (
    <TableRow className="mon-runs-table-row" data-run-id={run.runId} onClick={() => onSelect(run.runId)}>
      <TableCell>
        <StatusTag status={run.status} />
      </TableCell>
      <TableCell className="mon-mono">{shortRunId(run.runId)}</TableCell>
      <TableCell className="mon-table-workflow" title={run.workflowKey ?? "unknown workflow"}>
        {run.workflowKey ?? "unknown"}
      </TableCell>
      <TableCell>
        <RunProgressCell run={run} /> <FailedTaskBadge count={failedTaskCountOf(run)} />
      </TableCell>
      <TableCell><RunEtaCell run={run} /></TableCell>
      <TableCell className="mon-dim">
        <Ago ms={run.startedAtMs ?? run.createdAtMs} />
      </TableCell>
      <TableCell className="mon-dim mon-mono">
        <Elapsed startMs={run.startedAtMs ?? run.createdAtMs} endMs={run.finishedAtMs} />
      </TableCell>
    </TableRow>
  );
}
