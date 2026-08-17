/** @jsxImportSource react */
import { useMemo, useState } from "react";
import {
  createGatewayReactRoot,
  useGatewayActions,
  useGatewayNodeOutput,
  useGatewayRun,
  useGatewayRunEvents,
  useGatewayRuns,
} from "smthrs/gateway-react";
import { ApprovalPanel, NodeOutputView, RunEventLog, RunTree, WorkflowUiShell } from "smthrs/gateway-ui";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
  KpiStat,
  SectionHeader,
  SmithersUiStyles,
  StatusPill,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "smthrs/ui";

const WORKFLOW_KEY = "flows-migration";

type RunSummary = { runId: string; workflowKey?: string; status?: string; createdAtMs?: number };

// ── Pure helpers (exported for unit tests) ───────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function unwrap(value: unknown): Record<string, unknown> {
  const outer = isRecord(value) ? value : {};
  return isRecord(outer.row) ? (outer.row as Record<string, unknown>) : outer;
}

function list(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === "string" && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

export type UiLane = { slug: string; title: string; repo: string };
export type UiStage = { id: string; title: string; lanes: UiLane[] };

/** Read the ledger node's output row into the stage and lane list the UI draws. */
export function parseLedgerStages(value: unknown): UiStage[] {
  const row = unwrap(value);
  const stages: UiStage[] = [];
  for (const stageRaw of list(row.stages)) {
    if (!isRecord(stageRaw)) continue;
    const id = typeof stageRaw.id === "string" ? stageRaw.id : "";
    if (!id) continue;
    const lanes: UiLane[] = [];
    for (const laneRaw of list(stageRaw.lanes)) {
      if (!isRecord(laneRaw)) continue;
      const slug = typeof laneRaw.slug === "string" ? laneRaw.slug : "";
      if (!slug) continue;
      lanes.push({
        slug,
        title: typeof laneRaw.title === "string" ? laneRaw.title : slug,
        repo: laneRaw.repo === "flows" ? "flows" : "smithers",
      });
    }
    stages.push({
      id,
      title: typeof stageRaw.title === "string" ? stageRaw.title : "Stage " + id,
      lanes,
    });
  }
  return stages;
}

/** Count the finished nodes seen so far, used only to force a re-read of rows. */
export function finishedNodeCount(events: unknown[]): number {
  let count = 0;
  for (const event of events) {
    if (isRecord(event) && typeof event.type === "string" && event.type.includes("node.finished")) count += 1;
  }
  return count;
}

export function shortRunId(runId: string | undefined): string {
  if (!runId) return "no run";
  return runId.length > 14 ? runId.slice(0, 6) + "..." + runId.slice(-6) : runId;
}

/**
 * Map a lane's persisted rows onto the pill the card shows. `status` is a
 * run-status string so StatusPill tints it; `label` is what the human reads.
 */
export function laneBadge(gate: unknown, review: unknown, decision: unknown): { label: string; status: string } {
  const decisionRow = unwrap(decision);
  if (decisionRow.decision === "approved" || decisionRow.approved === true) {
    return { label: "approved", status: "ok" };
  }
  if (decisionRow.decision === "denied" || decisionRow.approved === false) {
    return { label: "denied", status: "failed" };
  }
  const gateRow = unwrap(gate);
  if (Object.keys(gateRow).length === 0) return { label: "building", status: "running" };
  const ok = gateRow.ok === true || gateRow.ok === 1 || gateRow.ok === "1";
  if (!ok) return { label: "gate red", status: "failed" };
  const verdict = unwrap(review).verdict;
  if (verdict === "approve") return { label: "awaiting approval", status: "waiting" };
  return { label: "in review", status: "running" };
}

// ── Components ───────────────────────────────────────────────────────────────

function LaneCard(props: { runId: string | undefined; lane: UiLane }) {
  const gate = useGatewayNodeOutput({ runId: props.runId, nodeId: props.lane.slug + ":gate", iteration: 0 });
  const review = useGatewayNodeOutput({ runId: props.runId, nodeId: props.lane.slug + ":review", iteration: 0 });
  const decision = useGatewayNodeOutput({ runId: props.runId, nodeId: props.lane.slug + ":approval", iteration: 0 });
  const artifact = useGatewayNodeOutput({ runId: props.runId, nodeId: props.lane.slug + ":artifact", iteration: 0 });
  const badge = laneBadge(gate.data, review.data, decision.data);
  const artifactPath = unwrap(artifact.data).artifactPath;

  return (
    <Card data-testid={"fm-lane-" + props.lane.slug}>
      <CardHeader>
        <CardTitle>
          {props.lane.title} <Badge>{props.lane.repo}</Badge> <StatusPill status={badge.status} label={badge.label} />
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div>
          <code>{props.lane.slug}</code>
        </div>
        {typeof unwrap(gate.data).summary === "string" ? <div>{String(unwrap(gate.data).summary)}</div> : null}
        {typeof artifactPath === "string" && artifactPath ? <div>Report: {artifactPath}</div> : null}
      </CardContent>
    </Card>
  );
}

function StageSection(props: { runId: string | undefined; stage: UiStage }) {
  const report = useGatewayNodeOutput({
    runId: props.runId,
    nodeId: "stage-" + props.stage.id + ":report",
    iteration: 0,
  });
  const integrate = useGatewayNodeOutput({
    runId: props.runId,
    nodeId: "stage-" + props.stage.id + ":integrate",
    iteration: 0,
  });
  const reportRow = unwrap(report.data);
  const integrateRow = unwrap(integrate.data);

  return (
    <div data-testid={"fm-stage-" + props.stage.id}>
      <SectionHeader eyebrow={"stage " + props.stage.id} title={props.stage.title}>
        {typeof integrateRow.summary === "string" ? String(integrateRow.summary) : null}
      </SectionHeader>
      <div>
        <KpiStat label="lanes" value={String(reportRow.lanesTotal ?? props.stage.lanes.length)} />
        <KpiStat label="green" value={String(reportRow.lanesGreen ?? 0)} />
        <KpiStat label="approved" value={String(reportRow.lanesApproved ?? 0)} />
      </div>
      {props.stage.lanes.length === 0 ? (
        <EmptyState title="No lanes planned for this stage." />
      ) : (
        props.stage.lanes.map((lane) => <LaneCard key={lane.slug} runId={props.runId} lane={lane} />)
      )}
      {typeof reportRow.reportPath === "string" && reportRow.reportPath ? (
        <div data-testid={"fm-stage-report-" + props.stage.id}>Stage report: {String(reportRow.reportPath)}</div>
      ) : null}
    </div>
  );
}

function runIdFromUrl(): string | undefined {
  if (typeof window === "undefined") return undefined;
  const value = new URLSearchParams(window.location.search).get("runId");
  return value ?? undefined;
}

export function FlowsMigrationApp() {
  const [selectedRunId, setSelectedRunId] = useState<string | undefined>();
  const [selectedNodeId, setSelectedNodeId] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  const runsQuery = useGatewayRuns({ filter: { limit: 20 } });
  const actions = useGatewayActions();
  const runs = useMemo(
    () =>
      ((runsQuery.data ?? []) as RunSummary[]).filter((run) => !run.workflowKey || run.workflowKey === WORKFLOW_KEY),
    [runsQuery.data],
  );
  const activeRunId = selectedRunId ?? runIdFromUrl() ?? runs[0]?.runId;
  const activeRunDetail = useGatewayRun(activeRunId);
  const activeRun = (activeRunDetail.data as RunSummary | undefined) ?? runs.find((run) => run.runId === activeRunId);
  const stream = useGatewayRunEvents(activeRunId, { afterSeq: undefined });
  const finished = finishedNodeCount((stream.events ?? []) as unknown[]);

  const preflightQuery = useGatewayNodeOutput({ runId: activeRunId, nodeId: "preflight", iteration: 0 });
  const ledgerQuery = useGatewayNodeOutput({ runId: activeRunId, nodeId: "ledger", iteration: 0 });
  const summaryQuery = useGatewayNodeOutput({ runId: activeRunId, nodeId: "summary", iteration: 0 });
  const stages = useMemo(() => parseLedgerStages(ledgerQuery.data), [ledgerQuery.data]);
  const preflight = unwrap(preflightQuery.data);
  const summary = unwrap(summaryQuery.data);

  async function refresh() {
    await Promise.all([
      runsQuery.refetch(),
      activeRunDetail.refetch(),
      preflightQuery.refetch(),
      ledgerQuery.refetch(),
      summaryQuery.refetch(),
    ]);
  }

  async function launch() {
    setBusy(true);
    try {
      const run = await actions.launchRun({ workflow: WORKFLOW_KEY, input: {} });
      setSelectedRunId(run.runId);
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <WorkflowUiShell
      title="Flows Migration"
      meta={shortRunId(activeRunId)}
      actions={
        <>
          {activeRun ? <StatusPill data-testid="fm-status" status={activeRun.status ?? "idle"} /> : null}
          <Button variant="outline" data-testid="fm-refresh" onClick={() => void refresh()} disabled={busy}>
            Refresh
          </Button>
          <Button data-testid="fm-launch" onClick={() => void launch()} disabled={busy}>
            Launch
          </Button>
        </>
      }
      testId="fm-shell"
    >
      <SmithersUiStyles />

      {typeof preflight.summary === "string" && preflight.summary ? (
        <Card data-testid="fm-preflight">
          <CardHeader>
            <CardTitle>Preflight</CardTitle>
          </CardHeader>
          <CardContent>
            <div>{String(preflight.summary)}</div>
            {typeof preflight.collisionsJson === "string" ? (
              <div>
                Colliding package names: <code>{String(preflight.collisionsJson)}</code>
              </div>
            ) : null}
            {typeof preflight.smithersEffectPin === "string" ? (
              <div>
                effect: smithers <code>{String(preflight.smithersEffectPin)}</code> vs flows{" "}
                <code>{String(preflight.flowsEffectPin ?? "")}</code>
              </div>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      <SectionHeader title="Stages">Each stage unlocks only after the previous sign-off.</SectionHeader>
      {stages.length === 0 ? (
        <EmptyState title="No plan yet" description="Stages appear once the planner finishes and you approve them." />
      ) : (
        <div key={"stages-" + finished} data-testid="fm-stages">
          {stages.map((stage) => (
            <StageSection key={stage.id} runId={activeRunId} stage={stage} />
          ))}
        </div>
      )}

      {typeof summary.summary === "string" && summary.summary ? (
        <Card data-testid="fm-summary">
          <CardHeader>
            <CardTitle>Summary</CardTitle>
          </CardHeader>
          <CardContent>{String(summary.summary)}</CardContent>
        </Card>
      ) : null}

      <SectionHeader title="Approvals">Plan blessing, per-lane decisions, and stage sign-offs.</SectionHeader>
      <ApprovalPanel filter={activeRunId ? { runId: activeRunId } : undefined} />

      <Tabs defaultValue="runs">
        <TabsList>
          <TabsTrigger value="runs">Recent runs</TabsTrigger>
          <TabsTrigger value="tree">Run tree</TabsTrigger>
          <TabsTrigger value="events">Events</TabsTrigger>
        </TabsList>
        <TabsContent value="runs">
          {runs.map((run) => (
            <Button
              key={run.runId}
              variant={run.runId === activeRunId ? "default" : "ghost"}
              data-testid={"fm-run-" + run.runId}
              onClick={() => setSelectedRunId(run.runId)}
            >
              {shortRunId(run.runId)} <StatusPill status={run.status} />
            </Button>
          ))}
          {runs.length === 0 ? <EmptyState title="No runs yet." /> : null}
        </TabsContent>
        <TabsContent value="tree">
          <RunTree
            runId={activeRunId}
            activeNodeId={selectedNodeId}
            onSelectNode={(node) => setSelectedNodeId(node.id)}
          />
          <NodeOutputView runId={activeRunId} nodeId={selectedNodeId} />
        </TabsContent>
        <TabsContent value="events">
          <RunEventLog runId={activeRunId} />
        </TabsContent>
      </Tabs>
    </WorkflowUiShell>
  );
}

// Mount only on the gateway-served page so unit tests can import the helpers.
if (typeof document !== "undefined" && document.getElementById("root")) {
  createGatewayReactRoot(<FlowsMigrationApp />);
}
