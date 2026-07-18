/** @jsxImportSource react */
import { useState } from "react";
import { useGatewayActions, useGatewayApprovals } from "smithers-orchestrator/gateway-react";
import {
  Button,
  Table,
  TableBody,
  TableHead,
  TableHeader,
  TableRow,
} from "smithers-orchestrator/ui";
import {
  connectionViewFor,
  groupRuns,
  paginateRuns,
  RUNS_PAGE_SIZE,
  shortRunId,
  toneForStatus,
  waitTone,
  type RunRow,
} from "./monitorModel.ts";
import { RunRailRow, RunsPagination } from "./monitorShell.tsx";
import { Ago, Elapsed, LiveElapsed, useNowMs } from "./monitorShared.tsx";
import { FailedTaskBadge } from "./monitorFailedBadge.tsx";
import { failedTaskCountOf } from "./monitorAttentionModel.ts";
import { RunProgressCell, RunsTableRow } from "./monitorRunsTableRow.tsx";

function ApprovalWait({ requestedAtMs }: { requestedAtMs: number | undefined }) {
  const now = useNowMs();
  if (!requestedAtMs) return <span className="mon-dim">—</span>;
  const tone = waitTone(now - requestedAtMs);
  return (
    <span className={`mon-wait tone-${tone}`}>
      waiting <LiveElapsed startMs={requestedAtMs} />
    </span>
  );
}

// ---------------------------------------------------------------------------
// Approvals inbox (all pending gates across every run).
// ---------------------------------------------------------------------------

type ApprovalLike = {
  runId: string;
  nodeId: string;
  iteration?: number;
  workflowKey?: string;
  requestTitle?: string;
  requestSummary?: string;
  requestedAtMs?: number;
};

export function ApprovalsInbox({
  onSelectRun,
  onResult,
}: {
  onSelectRun: (runId: string) => void;
  onResult: (kind: "ok" | "err", text: string) => void;
}) {
  const approvalsQuery = useGatewayApprovals();
  const actions = useGatewayActions();
  const [decidingKey, setDecidingKey] = useState<string | null>(null);
  const approvals = (approvalsQuery.data ?? []) as ApprovalLike[];
  if (approvals.length === 0) return null;

  const decide = async (approval: ApprovalLike, approved: boolean) => {
    if (!approved && !window.confirm(`Deny "${approval.requestTitle ?? approval.nodeId}"? This fails the waiting gate.`)) {
      return;
    }
    const key = `${approval.runId}:${approval.nodeId}:${approval.iteration ?? 0}`;
    setDecidingKey(key);
    try {
      await actions.submitApproval({
        runId: approval.runId,
        nodeId: approval.nodeId,
        iteration: approval.iteration ?? 0,
        approved,
        decision: { approved },
      });
      onResult("ok", `${approved ? "Approved" : "Denied"} ${approval.nodeId} on ${shortRunId(approval.runId)}.`);
    } catch (error) {
      onResult("err", `Approval failed: ${error instanceof Error ? error.message : String(error)}`);
      await approvalsQuery.refetch();
    } finally {
      setDecidingKey(null);
    }
  };

  return (
    <section className="mon-inbox" data-testid="monitor-approvals">
      <h2 className="mon-kicker">
        Approvals <span className="mon-count">{approvals.length}</span>
      </h2>
      {approvals.map((approval) => {
        const key = `${approval.runId}:${approval.nodeId}:${approval.iteration ?? 0}`;
        const busy = decidingKey === key;
        return (
          <div className="mon-approval" key={key}>
            <button type="button" className="mon-approval-main" onClick={() => onSelectRun(approval.runId)}>
              <div className="mon-approval-title">{approval.requestTitle ?? approval.nodeId}</div>
              <div className="mon-approval-meta">
                <span className="mon-mono">{approval.workflowKey ?? "workflow"}</span>
                <span className="mon-mono mon-dim">{shortRunId(approval.runId)}</span>
                <ApprovalWait requestedAtMs={approval.requestedAtMs} />
              </div>
              {approval.requestSummary ? <div className="mon-approval-summary">{approval.requestSummary}</div> : null}
            </button>
            <div className="mon-approval-actions">
              <Button
                variant="outline"
                className="mon-btn-ok"
                disabled={busy}
                onClick={() => void decide(approval, true)}
              >
                Approve
              </Button>
              <Button variant="destructive" disabled={busy} onClick={() => void decide(approval, false)}>
                Deny
              </Button>
            </div>
          </div>
        );
      })}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Runs rail.
// ---------------------------------------------------------------------------

function RunListRow({
  run,
  active,
  onSelect,
}: {
  run: RunRow;
  active: boolean;
  onSelect: (runId: string) => void;
}) {
  const tone = toneForStatus(run.status);
  const live = tone === "running" || tone === "waiting";
  return (
    <RunRailRow
      runId={run.runId}
      name={run.workflowKey ?? "unknown"}
      title={run.workflowKey ?? "unknown workflow"}
      shortId={shortRunId(run.runId)}
      tone={tone}
      pulse={tone === "running"}
      when={
        live ? <Elapsed startMs={run.startedAtMs ?? run.createdAtMs} endMs={undefined} /> : <Ago ms={run.createdAtMs} />
      }
      active={active}
      onSelect={onSelect}
      badge={<FailedTaskBadge count={failedTaskCountOf(run)} />}
    />
  );
}

export function RunsRail({
  runs,
  loading,
  connStatus,
  selectedRunId,
  onSelect,
}: {
  runs: RunRow[];
  loading: boolean;
  connStatus: string;
  selectedRunId: string | undefined;
  onSelect: (runId: string) => void;
}) {
  const groups = groupRuns(runs);
  // Offline and unauthorized carry state-specific banners (an auth failure
  // must never read like a network outage); connecting states just load.
  const banner = connectionViewFor(connStatus).banner;
  return (
    <nav className="mon-rail-runs" data-testid="monitor-runs">
      {banner && runs.length === 0 ? (
        <div className="mon-banner tone-failed" data-testid={`monitor-runs-${connStatus}`}>
          <div>{banner.title}</div>
          <div className="mon-dim">{banner.detail}</div>
        </div>
      ) : null}
      {!banner && loading && runs.length === 0 ? <div className="mon-empty">Loading runs…</div> : null}
      {!banner && !loading && runs.length === 0 ? (
        <div className="mon-empty" data-testid="monitor-empty">
          <div>No runs match.</div>
          <div className="mon-dim">
            Launch one with <code>smithers up &lt;workflow&gt;</code> or <code>smithers workflow run &lt;id&gt;</code>.
          </div>
        </div>
      ) : null}
      {groups.map((group) => (
        <section key={group.group} className="mon-run-group">
          <h2 className="mon-kicker">
            {group.title} <span className="mon-count">{group.runs.length}</span>
          </h2>
          {group.runs.map((run) => (
            <RunListRow key={run.runId} run={run} active={run.runId === selectedRunId} onSelect={onSelect} />
          ))}
        </section>
      ))}
    </nav>
  );
}

// ---------------------------------------------------------------------------
// Landing runs table: every run this gateway owns, paginated, shown in the
// main area while no run is selected. The gateway's listRuns filter has no
// offset/cursor, so pagination is client-side over the fetched window (see
// paginateRuns in ./monitorModel.ts). Same rows, same filters, same select
// handler as the rail — a scannable overview instead of an empty hero.
// ---------------------------------------------------------------------------

export { RunProgressCell } from "./monitorRunsTableRow.tsx";

export function RunsTable({
  runs,
  loading,
  page,
  onPageChange,
  onSelect,
}: {
  runs: RunRow[];
  loading: boolean;
  page: number;
  onPageChange: (page: number) => void;
  onSelect: (runId: string) => void;
}) {
  const { pageRows, page: shownPage, pageCount, total } = paginateRuns(runs, page, RUNS_PAGE_SIZE);
  if (total === 0) {
    return (
      <div className="mon-empty mon-empty-hero" data-testid="monitor-empty-detail">
        <div>{loading ? "Loading runs…" : "No runs match."}</div>
        <div className="mon-dim">
          {loading ? (
            "Live status, execution tree, node outputs, events, and approvals — for every run this gateway owns."
          ) : (
            <>
              Launch one with <code>smithers up &lt;workflow&gt;</code> or <code>smithers workflow run &lt;id&gt;</code>.
            </>
          )}
        </div>
      </div>
    );
  }
  const firstRow = (shownPage - 1) * RUNS_PAGE_SIZE + 1;
  const lastRow = Math.min(shownPage * RUNS_PAGE_SIZE, total);
  return (
    <section className="mon-panel mon-runs-table-panel">
      <header className="mon-panel-head">
        <h2 className="mon-kicker">
          All runs <span className="mon-count">{total}</span>
        </h2>
      </header>
      <div className="mon-runs-scroll">
        <Table className="mon-runs-table" data-testid="monitor-runs-table">
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Status</TableHead>
              <TableHead scope="col">Run</TableHead>
              <TableHead scope="col">Workflow</TableHead>
              <TableHead scope="col">Progress</TableHead>
              <TableHead scope="col">ETA</TableHead>
              <TableHead scope="col">Started</TableHead>
              <TableHead scope="col">Duration</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {pageRows.map((run) => <RunsTableRow key={run.runId} run={run} onSelect={onSelect} />)}
          </TableBody>
        </Table>
      </div>
      <RunsPagination
        page={shownPage}
        pageCount={pageCount}
        firstRow={firstRow}
        lastRow={lastRow}
        total={total}
        onPageChange={onPageChange}
      />
    </section>
  );
}
