/** @jsxImportSource react */
import { useMemo, useState } from "react";
import {
  createGatewayReactRoot,
  useGatewayActions,
  useGatewayNodeOutput,
  useGatewayRunEvents,
  useGatewayRunTree,
  useGatewayRuns,
} from "smithers-orchestrator/gateway-react";
import { WorkflowUiStyles } from "smithers-orchestrator/gateway-ui";

const WORKFLOW_KEY = "riskless-github-issue-sweep";
type Row = Record<string, unknown>;
function row(value: unknown): Row | null {
  if (!value || typeof value !== "object") return null;
  const data = value as Row;
  return data.row && typeof data.row === "object" ? (data.row as Row) : null;
}
function text(value: unknown) {
  return value == null ? "" : String(value);
}
function array(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}
function runIdFromUrl() {
  return typeof location === "undefined" ? undefined : (new URLSearchParams(location.search).get("runId") ?? undefined);
}
type LaneCardProps = {
  runId?: string;
  issueNumber: number;
  correctionIteration: number;
  landingIteration: number;
  closureIteration: number;
  runStatus: string;
};

function LaneCard({
  runId,
  issueNumber,
  correctionIteration,
  landingIteration,
  closureIteration,
  runStatus,
}: LaneCardProps) {
  const prefix = `i${issueNumber}`;
  // Hooks are deliberately fixed at this child component's top level. Each reads
  // structured data.row for one lane/iteration; tree display text is never used.
  const bootstrapOut = useGatewayNodeOutput({ runId, nodeId: `${prefix}:lane-bootstrap`, iteration: 0 });
  const refreshOut = useGatewayNodeOutput({ runId, nodeId: `${prefix}:live-refresh`, iteration: 0 });
  const solOut = useGatewayNodeOutput({ runId, nodeId: `${prefix}:sol-implement`, iteration: correctionIteration });
  const protectionOut = useGatewayNodeOutput({ runId, nodeId: `${prefix}:protection`, iteration: correctionIteration });
  const lunaOut = useGatewayNodeOutput({ runId, nodeId: `${prefix}:luna-proposal`, iteration: correctionIteration });
  const commitOut = useGatewayNodeOutput({ runId, nodeId: `${prefix}:commit`, iteration: correctionIteration });
  const evidenceOut = useGatewayNodeOutput({
    runId,
    nodeId: `${prefix}:review-evidence`,
    iteration: correctionIteration,
  });
  const reviewOut = useGatewayNodeOutput({ runId, nodeId: `${prefix}:fable-review`, iteration: correctionIteration });
  const reviewCheckOut = useGatewayNodeOutput({
    runId,
    nodeId: `${prefix}:review-check`,
    iteration: correctionIteration,
  });
  const gatesOut = useGatewayNodeOutput({ runId, nodeId: `${prefix}:candidate-gates`, iteration: correctionIteration });
  const readinessOut = useGatewayNodeOutput({
    runId,
    nodeId: `${prefix}:lane-readiness`,
    iteration: correctionIteration,
  });
  const landingCorrectionEvidenceOut = useGatewayNodeOutput({
    runId,
    nodeId: `${prefix}:landing-correction-evidence`,
    iteration: landingIteration,
  });
  const landingSolOut = useGatewayNodeOutput({
    runId,
    nodeId: `${prefix}:landing-sol-implement`,
    iteration: landingIteration,
  });
  const landingProtectionOut = useGatewayNodeOutput({
    runId,
    nodeId: `${prefix}:landing-protection`,
    iteration: landingIteration,
  });
  const landingLunaOut = useGatewayNodeOutput({
    runId,
    nodeId: `${prefix}:landing-luna-proposal`,
    iteration: landingIteration,
  });
  const landingAmendOut = useGatewayNodeOutput({
    runId,
    nodeId: `${prefix}:landing-amend`,
    iteration: landingIteration,
  });
  const landingRefreshOut = useGatewayNodeOutput({
    runId,
    nodeId: `${prefix}:landing-refresh`,
    iteration: landingIteration,
  });
  const rebaseOut = useGatewayNodeOutput({ runId, nodeId: `${prefix}:rebase`, iteration: landingIteration });
  const landingReviewOut = useGatewayNodeOutput({
    runId,
    nodeId: `${prefix}:landing-review`,
    iteration: landingIteration,
  });
  const landingReviewCheckOut = useGatewayNodeOutput({
    runId,
    nodeId: `${prefix}:landing-review-check`,
    iteration: landingIteration,
  });
  const landingGatesOut = useGatewayNodeOutput({
    runId,
    nodeId: `${prefix}:landing-gates`,
    iteration: landingIteration,
  });
  const publicationOut = useGatewayNodeOutput({ runId, nodeId: `${prefix}:publication`, iteration: landingIteration });
  const closureRefreshOut = useGatewayNodeOutput({
    runId,
    nodeId: `${prefix}:closure-refresh`,
    iteration: closureIteration,
  });
  const closeProposalOut = useGatewayNodeOutput({
    runId,
    nodeId: `${prefix}:close-proposal`,
    iteration: closureIteration,
  });
  const closureOut = useGatewayNodeOutput({ runId, nodeId: `${prefix}:closure`, iteration: closureIteration });
  const terminalOut = useGatewayNodeOutput({ runId, nodeId: `${prefix}:terminal`, iteration: 0 });
  const bootstrap = row(bootstrapOut.data);
  const refresh = row(refreshOut.data);
  const sol = row(solOut.data);
  const protection = row(protectionOut.data);
  const luna = row(lunaOut.data);
  const commit = row(commitOut.data);
  const candidateEvidence = row(evidenceOut.data);
  const review = row(reviewOut.data);
  const reviewCheck = row(reviewCheckOut.data);
  const gates = row(gatesOut.data);
  const landingCorrectionEvidence = row(landingCorrectionEvidenceOut.data);
  const landingSol = row(landingSolOut.data);
  const landingProtection = row(landingProtectionOut.data);
  const landingLuna = row(landingLunaOut.data);
  const landingAmend = row(landingAmendOut.data);
  const landingRefresh = row(landingRefreshOut.data);
  const rebase = row(rebaseOut.data);
  const landingReview = row(landingReviewOut.data);
  const landingReviewCheck = row(landingReviewCheckOut.data);
  const landingGates = row(landingGatesOut.data);
  const publication = row(publicationOut.data);
  const closureRefresh = row(closureRefreshOut.data);
  const closeProposal = row(closeProposalOut.data);
  const closure = row(closureOut.data);
  const terminal = row(terminalOut.data);
  const readiness = row(readinessOut.data);
  const failure =
    terminal && terminal.result !== "landed+closed"
      ? text(terminal.reason)
      : bootstrap?.ready === false
        ? `bootstrap: ${text(bootstrap.summary)}`
        : refresh?.ready === false
          ? `live refresh: ${text(refresh.summary)}`
          : sol?.decision === "defer"
            ? `Sol: ${text(sol.summary)}`
            : protection?.passed === false
              ? `protection: ${text(protection.decision)} ${array(protection.violations).map(text).join("; ")}`
              : luna?.valid === false
                ? `Luna proposal: ${text(luna.rationale)}`
                : commit?.decision === "reject"
                  ? `commit proof: ${text(commit.failure)}`
                  : review?.approved === false
                    ? `candidate Fable: ${array(review.findings).map(text).join("; ")}`
                    : reviewCheck?.passed === false
                      ? `candidate binding: ${text(reviewCheck.summary)}`
                      : gates?.passed === false
                        ? `candidate gates: ${text(gates.summary)}`
                        : landingProtection?.passed === false
                          ? `landing protection: ${array(landingProtection.violations).map(text).join("; ")}`
                          : landingLuna?.valid === false
                            ? `landing Luna: ${text(landingLuna.rationale)}`
                            : landingAmend?.decision === "reject"
                              ? `landing amend: ${text(landingAmend.failure)}`
                              : landingRefresh?.decision === "defer"
                                ? `landing refresh: ${text(landingRefresh.summary)}`
                                : rebase && (rebase.decision === "reject" || rebase.status === "conflict-aborted")
                                  ? `rebase: ${text(rebase.summary)}`
                                  : landingReview?.approved === false
                                    ? `landing Fable: ${array(landingReview.findings).map(text).join("; ")}`
                                    : landingReviewCheck?.passed === false
                                      ? `landing binding: ${text(landingReviewCheck.summary)}`
                                      : landingGates?.passed === false
                                        ? `landing gates: ${text(landingGates.summary)}`
                                        : publication?.reachable === false
                                          ? `publication: ${text(publication.summary)}`
                                          : closureRefresh?.ready === false
                                            ? `closure refresh: ${text(closureRefresh.summary)}`
                                            : closeProposal?.decision === "defer"
                                              ? `Luna closure: ${text(closeProposal.rationale)}`
                                              : closure?.closed === false
                                                ? `closure: ${text(closure.summary)}`
                                                : "";
  const phase = terminal
    ? "terminal"
    : closure
      ? "closure"
      : closeProposal
        ? "Luna closure"
        : closureRefresh
          ? "closure refresh"
          : publication
            ? "publication"
            : landingGates
              ? "landing gates"
              : landingReviewCheck
                ? "landing binding"
                : landingReview
                  ? "landing review"
                  : rebase
                    ? "rebase"
                    : landingRefresh
                      ? "landing refresh"
                      : landingAmend
                        ? "landing amend"
                        : landingLuna
                          ? "landing Luna"
                          : landingProtection
                            ? "landing protection"
                            : landingSol
                              ? "landing Sol correction"
                              : landingCorrectionEvidence
                                ? "landing correction evidence"
                                : readiness?.ready
                                  ? "landing queued"
                                  : gates
                                    ? "candidate gates"
                                    : reviewCheck
                                      ? "review binding"
                                      : review
                                        ? "Fable review"
                                        : candidateEvidence
                                          ? "candidate evidence"
                                          : commit
                                            ? "commit proof"
                                            : luna
                                              ? "Luna proposal"
                                              : protection
                                                ? "protection"
                                                : sol
                                                  ? "Sol correction"
                                                  : refresh
                                                    ? "live refresh"
                                                    : bootstrap
                                                      ? "bootstrap"
                                                      : "waiting";
  return (
    <article className={`lane ${failure ? "bad" : terminal?.result === "landed+closed" ? "good" : ""}`}>
      <div className="laneTop">
        <strong>#{issueNumber}</strong>
        <span className="badge">{phase}</span>
      </div>
      <div className="muted">
        run: {runStatus || "unknown"} · correction attempt {Number(readiness?.attempt ?? correctionIteration + 1)} ·
        landing attempt {landingIteration + 1} · closure attempt{" "}
        {Number(closureRefresh?.closureAttempt ?? closureIteration + 1)}
      </div>
      <div className="facts">
        <span>Sol {text(sol?.decision || "—")}</span>
        <span>Fable {review?.approved === true ? "approved" : review ? "rejected" : "—"}</span>
        <span>candidate gates {gates?.passed === true ? "pass" : gates ? "fail" : "—"}</span>
        <span>rebase {text(rebase?.status || "—")}</span>
        <span>rereview {landingReview?.approved === true ? "approved" : landingReview ? "rejected" : "—"}</span>
        <span>landing gates {landingGates?.passed === true ? "pass" : landingGates ? "fail" : "—"}</span>
        <span>remote tip {publication?.reachable === true ? "exact" : publication ? "not proven" : "—"}</span>
        <span>closure {closure?.closed === true ? "closed" : closure ? "not closed" : "—"}</span>
        <span>result {text(terminal?.result || "—")}</span>
      </div>
      {failure ? <div className="failure">{failure}</div> : null}
    </article>
  );
}

function App() {
  const runs = useGatewayRuns({ filter: { limit: 30 } });
  const [selected, setSelected] = useState(runIdFromUrl());
  const candidates = (Array.isArray(runs.data) ? runs.data : ((runs.data as any)?.runs ?? [])).filter(
    (candidate: any) => String(candidate.workflowKey ?? candidate.workflowName ?? "") === WORKFLOW_KEY,
  );
  const runId = selected ?? candidates[0]?.runId;
  const selectedRun = candidates.find((candidate: any) => candidate.runId === runId);
  const actualRunStatus = text(selectedRun?.status || "unknown");
  const events = useGatewayRunEvents(runId, { afterSeq: undefined });
  const tree = useGatewayRunTree(runId);
  const actions = useGatewayActions();
  const [busy, setBusy] = useState(false);
  const iterationFor = (...nodeIds: string[]) =>
    Math.max(
      0,
      ...(tree.nodes ?? [])
        .filter((node: any) => nodeIds.includes(String(node.id ?? node.nodeId ?? "")))
        .map((node: any) => Number(node.iteration ?? 0)),
    );
  const normalizeOut = useGatewayNodeOutput({ runId, nodeId: "normalize-inputs", iteration: 0 });
  const discoveryOut = useGatewayNodeOutput({ runId, nodeId: "discover-issues", iteration: 0 });
  const ledgerOut = useGatewayNodeOutput({ runId, nodeId: "admission-ledger", iteration: 0 });
  const finalOut = useGatewayNodeOutput({ runId, nodeId: "final-report", iteration: 0 });
  const normalize = row(normalizeOut.data);
  const discovery = row(discoveryOut.data);
  const ledger = row(ledgerOut.data);
  const final = row(finalOut.data);
  const dispositions = useMemo(
    () => array(ledger?.dispositions).filter((item): item is Row => !!item && typeof item === "object"),
    [ledger],
  );
  const laneNumbers = useMemo(
    () =>
      [
        ...new Set<number>([
          ...array(ledger?.admittedIssueNumbers).map(Number),
          ...(tree.nodes ?? [])
            .map((node: any) => String(node.id ?? node.nodeId ?? "").match(/^i(\d+):(lane-bootstrap|terminal)$/)?.[1])
            .filter(Boolean)
            .map(Number),
        ]),
      ].sort((a, b) => a - b),
    [ledger, tree.nodes],
  );
  async function cancel() {
    if (!runId) return;
    setBusy(true);
    try {
      await actions.cancelRun({ runId });
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="shell">
      <WorkflowUiStyles mode="theme" />
      <style>{`:root{color-scheme:dark;font-family:system-ui;background:#0e1014;color:#eef1f5}body{margin:0}.shell{padding:20px}.top,.laneTop{display:flex;justify-content:space-between;align-items:center}.top{border-bottom:1px solid #30343d;padding-bottom:14px}.muted{color:#9ca3af;font-size:12px}.grid,.lanes{display:grid;grid-template-columns:repeat(auto-fit,minmax(290px,1fr));gap:12px;margin-top:14px}.panel,.lane{background:#171a21;border:1px solid #30343d;border-radius:10px;padding:14px}.lane.bad{border-color:#8a3e46}.lane.good{border-color:#267653}.badge{padding:3px 8px;border-radius:999px;background:#263148;font-size:12px}.facts{display:grid;grid-template-columns:repeat(3,1fr);gap:5px;margin-top:10px;font-size:11px}.failure{margin-top:10px;color:#ffb4b4;font-size:12px}.mono{font-family:ui-monospace,monospace;font-size:12px;word-break:break-word}button{background:#263148;color:#fff;border:1px solid #46516a;border-radius:6px;padding:7px 11px}table{width:100%;border-collapse:collapse;margin-top:8px}td,th{text-align:left;border-top:1px solid #30343d;padding:7px;font-size:12px}`}</style>
      <header className="top">
        <div>
          <h1>Riskless GitHub Issue Sweep</h1>
          <div className="muted mono">
            run {runId ?? "—"} · actual state {actualRunStatus} · {events.events?.length ?? 0} events
          </div>
        </div>
        <div>
          <span className="badge">{normalize?.dryRun ? "DRY RUN" : "LIVE"}</span>{" "}
          <button disabled={!runId || busy} onClick={() => void cancel()}>
            Cancel
          </button>
        </div>
      </header>
      <div className="grid">
        <section className="panel">
          <strong>Discovery</strong>
          <div>
            <b>{text(discovery?.discoveredCount || 0)}</b> open non-PR issues
          </div>
          <div className="muted">
            coverage {text(ledger?.coverageComplete || false)} · admitted {array(ledger?.admittedIssueNumbers).length}
          </div>
        </section>
        <section className="panel">
          <strong>Safety</strong>
          <div>canonical {text(normalize?.repo)}</div>
          <div className="muted">at most 16 active issue/model lanes · serialized landing 1</div>
        </section>
        <section className="panel">
          <strong>Terminal</strong>
          <div>{text(final?.status || actualRunStatus)}</div>
          <div className="muted">{text(final?.summary)}</div>
        </section>
      </div>
      <section className="panel" style={{ marginTop: 14 }}>
        <strong>Disposition ledger</strong>
        <table>
          <thead>
            <tr>
              <th>Issue</th>
              <th>Disposition</th>
              <th>Mechanical reason</th>
            </tr>
          </thead>
          <tbody>
            {dispositions.map((item) => (
              <tr key={text(item.issueNumber)}>
                <td>#{text(item.issueNumber)}</td>
                <td>{text(item.disposition)}</td>
                <td>{text(item.reason)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <section>
        <h2>Issue lanes</h2>
        <div className="lanes">
          {laneNumbers.map((number) => (
            <LaneCard
              key={number}
              runId={runId}
              issueNumber={number}
              correctionIteration={iterationFor(`i${number}:sol-implement`, `i${number}:lane-readiness`)}
              landingIteration={iterationFor(
                `i${number}:landing-correction-evidence`,
                `i${number}:landing-sol-implement`,
                `i${number}:landing-protection`,
                `i${number}:landing-luna-proposal`,
                `i${number}:landing-amend`,
                `i${number}:landing-refresh`,
                `i${number}:rebase`,
                `i${number}:landing-review`,
                `i${number}:landing-gates`,
                `i${number}:publication`,
              )}
              closureIteration={iterationFor(
                `i${number}:closure-refresh`,
                `i${number}:close-proposal`,
                `i${number}:closure`,
              )}
              runStatus={actualRunStatus}
            />
          ))}
        </div>
      </section>
      <aside className="panel" style={{ marginTop: 14 }}>
        <strong>Recent runs</strong>
        <div>
          {candidates.map((candidate: any) => (
            <button key={candidate.runId} onClick={() => setSelected(candidate.runId)}>
              {String(candidate.runId).slice(0, 8)} · {candidate.status}
            </button>
          ))}
        </div>
      </aside>
    </main>
  );
}
createGatewayReactRoot(<App />);
