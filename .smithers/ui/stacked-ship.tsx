/** @jsxImportSource react */
import { useMemo, useState } from "react";
import {
  createGatewayReactRoot,
  useGatewayActions,
  useGatewayNodeOutput,
  useGatewayRun,
  useGatewayRunEvents,
  useGatewayRuns,
} from "smithers-orchestrator/gateway-react";
import { ApprovalPanel, NodeOutputView, RunEventLog, RunTree, WorkflowUiShell } from "smithers-orchestrator/gateway-ui";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
  SectionHeader,
  SmithersUiStyles,
  StatusPill,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "smithers-orchestrator/ui";

const WORKFLOW_KEY = "stacked-ship";

type RunSummary = { runId: string; workflowKey?: string; status?: string; createdAtMs?: number };

// ── Pure helpers (exported for unit tests) ───────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unwrap(value: unknown): Record<string, unknown> {
  const response = isRecord(value) ? value : {};
  return isRecord(response.row) ? (response.row as Record<string, unknown>) : response;
}

export type PlanLane = { slug: string; title: string };

/**
 * Read the planner node's output row into the lane list. Arrays may arrive as
 * real arrays or as persisted JSON strings; anything unusable yields [].
 */
export function parsePlanLanes(value: unknown): PlanLane[] {
  const row = unwrap(value);
  let entries: unknown = row.entries;
  if (typeof entries === "string") {
    try {
      entries = JSON.parse(entries);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(entries)) return [];
  const lanes: PlanLane[] = [];
  for (const entry of entries) {
    if (!isRecord(entry)) continue;
    const slug = typeof entry.slug === "string" ? entry.slug : "";
    if (!slug) continue;
    lanes.push({ slug, title: typeof entry.title === "string" ? entry.title : slug });
  }
  return lanes;
}

export type DecisionLabel = "approved" | "denied" | "pending";

export function decisionLabel(value: unknown): DecisionLabel {
  const row = unwrap(value);
  const approved = row.approved;
  if (approved === true || approved === 1 || approved === "1" || approved === "true") return "approved";
  if (approved === false || approved === 0 || approved === "0" || approved === "false") return "denied";
  return "pending";
}

export function rowIsOk(value: unknown): boolean {
  const row = unwrap(value);
  return row.ok === true || row.ok === 1 || row.ok === "1";
}

export type LaneView = {
  phase: string;
  hygiene: "green" | "red" | "none";
  selfReview: string;
  decision: DecisionLabel;
  artifactPath: string;
  headline: string;
};

/** Fold the lane's raw node outputs into what the card renders. */
export function laneView(rows: {
  workspace: unknown;
  hygiene: unknown;
  review: unknown;
  artifact: unknown;
  decision: unknown;
}): LaneView {
  const workspace = unwrap(rows.workspace);
  const review = unwrap(rows.review);
  const artifact = unwrap(rows.artifact);
  const hasWorkspace = workspace.ready === true || workspace.ready === 1;
  const hygieneRow = unwrap(rows.hygiene);
  const hygiene: LaneView["hygiene"] =
    hygieneRow.gateKey === undefined ? "none" : rowIsOk(rows.hygiene) ? "green" : "red";
  const decision = decisionLabel(rows.decision);
  const selfReview = typeof review.verdict === "string" ? review.verdict : "none";
  const phase = !hasWorkspace
    ? "pending"
    : decision === "approved"
      ? "approved"
      : hygiene !== "green" || selfReview !== "approve"
        ? "building"
        : decision === "denied"
          ? "reworking"
          : "reviewing";
  return {
    phase,
    hygiene,
    selfReview,
    decision,
    artifactPath: typeof artifact.artifactPath === "string" ? artifact.artifactPath : "",
    headline: typeof artifact.headline === "string" ? artifact.headline : "",
  };
}

/** Count NodeFinished frames defensively (frames wrap events at payload.event). */
export function finishedNodeCount(events: unknown[]): number {
  let count = 0;
  for (const frame of events) {
    if (!isRecord(frame)) continue;
    const payload = isRecord(frame.payload) ? frame.payload : {};
    if (payload.event === "NodeFinished") count += 1;
  }
  return count;
}

function shortRunId(runId: string | undefined) {
  return runId ? runId.slice(0, 8) : "--";
}

function runIdFromUrl(): string | undefined {
  if (typeof location === "undefined") return undefined;
  return new URLSearchParams(location.search).get("runId") ?? undefined;
}

// ── Lane card ────────────────────────────────────────────────────────────────

function LaneCard({
  runId,
  slug,
  title,
  index,
}: {
  runId: string | undefined;
  slug: string;
  title: string;
  index: number;
}) {
  const workspace = useGatewayNodeOutput({ runId, nodeId: slug + ":workspace", iteration: 0 });
  const hygiene = useGatewayNodeOutput({ runId, nodeId: slug + ":hygiene" });
  const review = useGatewayNodeOutput({ runId, nodeId: slug + ":self-review" });
  const artifact = useGatewayNodeOutput({ runId, nodeId: slug + ":artifact" });
  const decision = useGatewayNodeOutput({ runId, nodeId: slug + ":approval" });
  const view = laneView({
    workspace: workspace.data,
    hygiene: hygiene.data,
    review: review.data,
    artifact: artifact.data,
    decision: decision.data,
  });
  return (
    <Card data-testid={"stship-lane-" + slug}>
      <CardHeader>
        <CardTitle>
          {"#" + (index + 1) + " " + slug}
          <StatusPill status={view.phase} label={view.phase} />
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div>{view.headline || title}</div>
        <div>
          <Badge variant={view.hygiene === "green" ? "default" : "outline"}>hygiene: {view.hygiene}</Badge>{" "}
          <Badge variant={view.selfReview === "approve" ? "default" : "outline"}>self-review: {view.selfReview}</Badge>{" "}
          <Badge variant={view.decision === "approved" ? "default" : "outline"}>human: {view.decision}</Badge>
        </div>
        {view.artifactPath ? <code>{view.artifactPath}</code> : <span>No artifact yet.</span>}
      </CardContent>
    </Card>
  );
}

// ── App ──────────────────────────────────────────────────────────────────────

function StackedShipApp() {
  const [selectedRunId, setSelectedRunId] = useState<string | undefined>();
  const [selectedNodeId, setSelectedNodeId] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  const runsQuery = useGatewayRuns({ filter: { limit: 20 } });
  const actions = useGatewayActions();

  const shipRuns = useMemo(
    () =>
      ((runsQuery.data ?? []) as RunSummary[]).filter((run) => !run.workflowKey || run.workflowKey === WORKFLOW_KEY),
    [runsQuery.data],
  );
  const activeRunId = selectedRunId ?? runIdFromUrl() ?? shipRuns[0]?.runId;
  const activeRunDetail = useGatewayRun(activeRunId);
  const activeRun =
    (activeRunDetail.data as RunSummary | undefined) ?? shipRuns.find((run) => run.runId === activeRunId);
  const stream = useGatewayRunEvents(activeRunId, { afterSeq: 0 });
  const finished = finishedNodeCount((stream.events ?? []) as unknown[]);

  const planQuery = useGatewayNodeOutput({ runId: activeRunId, nodeId: "plan", iteration: 0 });
  const setupQuery = useGatewayNodeOutput({ runId: activeRunId, nodeId: "setup", iteration: 0 });
  const summaryQuery = useGatewayNodeOutput({ runId: activeRunId, nodeId: "summary", iteration: 0 });
  const lanes = useMemo(() => parsePlanLanes(planQuery.data), [planQuery.data]);
  const setupRow = unwrap(setupQuery.data);
  const summaryRow = unwrap(summaryQuery.data);

  async function refresh() {
    await Promise.all([
      runsQuery.refetch(),
      activeRunDetail.refetch(),
      planQuery.refetch(),
      setupQuery.refetch(),
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
      title="Stacked Ship"
      meta={activeRunId ? shortRunId(activeRunId) : "No run"}
      actions={
        <>
          {activeRun ? <StatusPill data-testid="stship-status" status={activeRun.status ?? "idle"} /> : null}
          <Button variant="outline" data-testid="stship-refresh" onClick={() => void refresh()} disabled={busy}>
            Refresh
          </Button>
          <Button data-testid="stship-launch" onClick={() => void launch()} disabled={busy}>
            Launch
          </Button>
        </>
      }
      testId="stship-shell"
    >
      <SmithersUiStyles />
      {typeof setupRow.summary === "string" && setupRow.summary ? (
        <SectionHeader eyebrow="stack" title={String(setupRow.summary)} />
      ) : null}

      <SectionHeader title="The stack, bottom to top" />
      {lanes.length === 0 ? (
        <EmptyState title="No plan yet" description="Lanes appear once the planner finishes." />
      ) : (
        <div key={"lanes-" + finished} data-testid="stship-lanes">
          {lanes.map((lane, index) => (
            <LaneCard key={lane.slug} runId={activeRunId} slug={lane.slug} title={lane.title} index={index} />
          ))}
        </div>
      )}

      {typeof summaryRow.summary === "string" && summaryRow.summary ? (
        <Card data-testid="stship-summary">
          <CardHeader>
            <CardTitle>Summary</CardTitle>
          </CardHeader>
          <CardContent>{String(summaryRow.summary)}</CardContent>
        </Card>
      ) : null}

      <SectionHeader title="Approvals" />
      <ApprovalPanel filter={activeRunId ? { runId: activeRunId } : undefined} />

      <Tabs defaultValue="runs">
        <TabsList>
          <TabsTrigger value="runs">Recent runs</TabsTrigger>
          <TabsTrigger value="tree">Run tree</TabsTrigger>
          <TabsTrigger value="events">Events</TabsTrigger>
        </TabsList>
        <TabsContent value="runs">
          {shipRuns.map((run) => (
            <Button
              key={run.runId}
              variant={run.runId === activeRunId ? "default" : "ghost"}
              data-testid={"stship-run-" + run.runId}
              onClick={() => setSelectedRunId(run.runId)}
            >
              {shortRunId(run.runId)} <StatusPill status={run.status} />
            </Button>
          ))}
          {shipRuns.length === 0 ? <EmptyState title="No runs yet." /> : null}
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

// Guard the mount so this module can be imported by unit tests (which exercise
// the exported pure helpers); only mount when the gateway-served page's real
// root element exists.
if (typeof document !== "undefined" && document.getElementById("root")) {
  createGatewayReactRoot(<StackedShipApp />);
}
