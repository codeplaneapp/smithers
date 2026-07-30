/** @jsxImportSource react */
import { useMemo, useState } from "react";
import {
  createGatewayReactRoot,
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
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
  KpiStat,
  SectionHeader,
  SmithersUiStyles,
  StatusPill,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "smithers-orchestrator/ui";

const WORKFLOW_KEY = "build-agentic-ui-library";

const COMPONENT_LANE_IDS = [
  "conversation-foundation",
  "prompt-attachments",
  "reasoning-tools",
  "plans-tasks-queues",
  "approvals-checkpoints",
  "sources-citations",
  "agent-identity-context",
  "coding-artifacts",
  "sandbox-previews",
  "workflow-canvas",
] as const;
const ADOPTION_LANE_IDS = ["adopt-chat", "adopt-gateway", "adopt-product"] as const;

type RunSummary = { runId: string; workflowKey?: string; status?: string };
type NodeState = "pending" | "running" | "finished" | "failed";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
export function asArray(value: unknown): unknown[] {
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
function unwrapRow(value: unknown): Record<string, unknown> {
  const response = isRecord(value) ? value : {};
  return isRecord(response.row) ? response.row : response;
}
function shortRunId(runId: string | undefined) {
  return runId ? runId.slice(0, 10) : "--";
}
function runIdFromUrl(): string | undefined {
  if (typeof location === "undefined") return undefined;
  return new URLSearchParams(location.search).get("runId") ?? undefined;
}
function baseNode(nodeId: string): string {
  return nodeId.split("@@", 1)[0] ?? nodeId;
}

// Ledger of node lifecycle derived from durable run-event frames.
export type Ledger = { states: Map<string, NodeState>; starts: Map<string, number>; order: Map<string, number> };
export function buildLedger(events: unknown[]): Ledger {
  const states = new Map<string, NodeState>();
  const starts = new Map<string, number>();
  const order = new Map<string, number>();
  let seq = 0;
  for (const frame of events) {
    if (!isRecord(frame) || !isRecord(frame.payload)) continue;
    const event = asString(frame.event);
    const nodeId = asString(frame.payload.nodeId);
    if (!event || !nodeId) continue;
    const node = baseNode(nodeId);
    seq += 1;
    if (!order.has(node)) order.set(node, seq);
    if (event === "NodeStarted") {
      states.set(node, "running");
      starts.set(node, (starts.get(node) ?? 0) + 1);
    } else if (event === "NodeFinished") {
      states.set(node, "finished");
    } else if (event === "NodeFailed") {
      states.set(node, "failed");
    }
  }
  return { states, starts, order };
}

type ManifestLane = {
  laneId: string;
  title: string;
  kind: string;
  implementModel: string;
  reviewSeats: string[];
  components: string[];
};
export function parseManifest(value: unknown): { plannedComponents: number; lanes: ManifestLane[] } {
  const row = unwrapRow(value);
  const lanes = asArray(row.lanes)
    .filter(isRecord)
    .map((lane) => ({
      laneId: asString(lane.laneId) ?? "",
      title: asString(lane.title) ?? "",
      kind: asString(lane.kind) ?? "component",
      implementModel: asString(lane.implementModel) ?? "",
      reviewSeats: asArray(lane.reviewSeats).map((seat) => String(seat)),
      components: asArray(lane.components).map((name) => String(name)),
    }))
    .filter((lane) => lane.laneId.length > 0);
  const planned = Number(row.plannedComponents);
  return {
    plannedComponents: Number.isFinite(planned)
      ? planned
      : lanes.reduce((sum, lane) => sum + lane.components.length, 0),
    lanes,
  };
}

export function laneLiveStatus(
  ledger: Ledger,
  prefix: string,
  resultRow: Record<string, unknown> | undefined,
): { status: string; label: string } {
  if (resultRow && typeof resultRow.lgtm === "boolean") {
    if (resultRow.lgtm === true) return { status: "finished", label: "lgtm" };
    return { status: "failed", label: resultRow.exhausted === true ? "exhausted" : "not lgtm" };
  }
  const phases: Array<[string, string]> = [
    [`${prefix}-implement`, "implementing"],
    [`${prefix}-validate`, "validating"],
    [`${prefix}-review-fable`, "review (fable)"],
    [`${prefix}-review-sol`, "review (sol)"],
  ];
  for (const [node, label] of phases) {
    if (ledger.states.get(node) === "running") return { status: "running", label };
  }
  if (ledger.states.get(`${prefix}-implement`) === "failed") return { status: "failed", label: "implement failed" };
  if (ledger.states.get(`${prefix}-implement`) === undefined) return { status: "waiting", label: "queued" };
  return { status: "running", label: "iterating" };
}

function LaneCard({
  runId,
  lane,
  ledger,
  refreshKey,
}: {
  runId: string | undefined;
  lane: ManifestLane;
  ledger: Ledger;
  refreshKey: number;
}) {
  const prefix =
    lane.kind === "adoption"
      ? lane.laneId.replace(/^adopt-/, "adopt-")
      : lane.kind === "integration"
        ? "integration"
        : `lane-${lane.laneId}`;
  const resultNode = lane.kind === "integration" ? "integration-implement" : `${prefix}-result`;
  const result = useGatewayNodeOutput({ runId, nodeId: resultNode, iteration: 0 });
  const row = unwrapRow(result.data);
  const hasResult = Object.keys(row).length > 0;
  const live = laneLiveStatus(ledger, prefix, hasResult ? row : undefined);
  const attempts = ledger.starts.get(`${prefix}-implement`) ?? 0;
  const verdicts = asArray(row.seatVerdicts).filter(isRecord);
  const filesChanged = asArray(row.filesChanged);
  const implemented = asArray(row.componentsImplemented);
  const deferred = asArray(row.componentsDeferred);
  return (
    <Card key={refreshKey} data-testid={`agui-lane-${lane.laneId}`}>
      <CardHeader>
        <CardTitle>{lane.laneId}</CardTitle>
        <StatusPill status={live.status} label={live.label} />
      </CardHeader>
      <CardContent>
        <CardDescription>{lane.title}</CardDescription>
        <Badge variant="muted">impl: {lane.implementModel}</Badge>
        {lane.reviewSeats.map((seat) => {
          const verdict = verdicts.find((entry) => asString(entry.seat) === seat);
          const approved = verdict?.approved === true;
          return (
            <Badge key={seat} variant={verdict ? (approved ? "default" : "destructive") : "muted"}>
              {seat} review{verdict ? (approved ? ": approved" : ": rejected") : ""}
            </Badge>
          );
        })}
        <Badge variant="muted">attempts {attempts}</Badge>
        {lane.components.length > 0 ? (
          <Badge variant="muted">
            {implemented.length}/{lane.components.length} components
          </Badge>
        ) : null}
        {filesChanged.length > 0 ? <Badge variant="muted">{filesChanged.length} files</Badge> : null}
        {deferred.length > 0 ? <Badge variant="warning">{deferred.length} deferred</Badge> : null}
        {asString(row.branch) ? (
          <CardDescription>
            branch {asString(row.branch)} · {asString(row.worktreePath) ?? ""}
          </CardDescription>
        ) : null}
        {asString(row.summary) ? <CardDescription>{asString(row.summary)}</CardDescription> : null}
      </CardContent>
    </Card>
  );
}

type MatrixRow = { component: string; lane: string; state: string; note: string | null };
export function coverageRows(
  auditValue: unknown,
  lanes: ManifestLane[],
  resultRows: Map<string, Record<string, unknown>>,
): MatrixRow[] {
  const audit = unwrapRow(auditValue);
  const fromAudit = asArray(audit.coverageMatrix)
    .filter(isRecord)
    .map((entry) => ({
      component: asString(entry.component) ?? "",
      lane: asString(entry.lane) ?? "",
      state: asString(entry.state) ?? "planned",
      note: asString(entry.note) ?? null,
    }))
    .filter((entry) => entry.component.length > 0);
  if (fromAudit.length > 0) return fromAudit;
  const rows: MatrixRow[] = [];
  for (const lane of lanes) {
    const result = resultRows.get(lane.laneId);
    const implemented = new Set(asArray(result?.componentsImplemented).map((name) => String(name)));
    const deferred = new Set(
      asArray(result?.componentsDeferred)
        .filter(isRecord)
        .map((entry) => String(entry.name ?? "")),
    );
    for (const component of lane.components) {
      const state = deferred.has(component)
        ? "deferred"
        : implemented.has(component)
          ? result?.lgtm === true
            ? "reviewed"
            : "implemented"
          : "planned";
      rows.push({ component, lane: lane.laneId, state, note: null });
    }
  }
  return rows;
}

function matrixPillStatus(state: string): string {
  if (state === "integrated" || state === "adopted") return "finished";
  if (state === "reviewed" || state === "implemented") return "running";
  if (state === "deferred") return "paused";
  return "waiting";
}

function CoverageMatrix({
  runId,
  lanes,
  resultRows,
  refreshKey,
}: {
  runId: string | undefined;
  lanes: ManifestLane[];
  resultRows: Map<string, Record<string, unknown>>;
  refreshKey: number;
}) {
  const auditFable = useGatewayNodeOutput({ runId, nodeId: "final-audit-fable", iteration: 0 });
  const [filter, setFilter] = useState<string>("all");
  const rows = useMemo(() => coverageRows(auditFable.data, lanes, resultRows), [auditFable.data, lanes, resultRows]);
  const states = ["all", "planned", "implemented", "reviewed", "integrated", "adopted", "deferred"];
  const visible = filter === "all" ? rows : rows.filter((row) => row.state === filter);
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.state, (counts.get(row.state) ?? 0) + 1);
  return (
    <div key={refreshKey} data-testid="agui-matrix">
      <SectionHeader
        title={`Component coverage (${rows.length})`}
        actions={
          <Tabs value={filter} onValueChange={setFilter}>
            <TabsList>
              {states.map((state) => (
                <TabsTrigger key={state} value={state} count={state === "all" ? rows.length : (counts.get(state) ?? 0)}>
                  {state}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        }
      />
      {visible.length === 0 ? (
        <EmptyState title="No components in this state." />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Component</TableHead>
              <TableHead>Lane</TableHead>
              <TableHead>State</TableHead>
              <TableHead>Note</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {visible.map((row) => (
              <TableRow key={`${row.lane}:${row.component}`}>
                <TableCell>{row.component}</TableCell>
                <TableCell>{row.lane}</TableCell>
                <TableCell>
                  <StatusPill status={matrixPillStatus(row.state)} label={row.state} />
                </TableCell>
                <TableCell>{row.note ?? ""}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}

function AuditCard({
  runId,
  seat,
  refreshKey,
}: {
  runId: string | undefined;
  seat: "fable" | "sol";
  refreshKey: number;
}) {
  const audit = useGatewayNodeOutput({ runId, nodeId: `final-audit-${seat}`, iteration: 0 });
  const row = unwrapRow(audit.data);
  if (Object.keys(row).length === 0) {
    return (
      <Card key={refreshKey}>
        <CardHeader>
          <CardTitle>{seat} audit</CardTitle>
          <StatusPill status="waiting" label="pending" />
        </CardHeader>
      </Card>
    );
  }
  const followUps = asArray(row.followUps).map((item) => String(item));
  return (
    <Card key={refreshKey} data-testid={`agui-audit-${seat}`}>
      <CardHeader>
        <CardTitle>{seat} audit</CardTitle>
        <StatusPill
          status={row.complete === true ? "finished" : "failed"}
          label={row.complete === true ? "complete" : "incomplete"}
        />
      </CardHeader>
      <CardContent>
        <Badge variant={row.deferralsEndorsed === true ? "default" : "destructive"}>
          deferrals {row.deferralsEndorsed === true ? "endorsed" : "not endorsed"}
        </Badge>
        <CardDescription>{asString(row.summary) ?? ""}</CardDescription>
        {followUps.map((item, index) => (
          <CardDescription key={index}>follow-up: {item}</CardDescription>
        ))}
      </CardContent>
    </Card>
  );
}

function MergePanel({ ledger }: { ledger: Ledger }) {
  const mergeNodes = [...ledger.order.entries()]
    .filter(([node]) => node.startsWith("merge-"))
    .sort((a, b) => a[1] - b[1]);
  if (mergeNodes.length === 0)
    return <EmptyState title="No merges yet." description="Merges start after every component lane settles." />;
  return (
    <div data-testid="agui-merges">
      {mergeNodes.map(([node], index) => (
        <Card key={node}>
          <CardHeader>
            <CardTitle>
              {index + 1}. {node.replace(/^merge-/, "")}
            </CardTitle>
            <StatusPill status={ledger.states.get(node) ?? "waiting"} />
          </CardHeader>
        </Card>
      ))}
    </div>
  );
}

export function AgenticUiProgramApp() {
  const [selectedRunId, setSelectedRunId] = useState<string | undefined>(runIdFromUrl());
  const [selectedNodeId, setSelectedNodeId] = useState<string | undefined>();

  const runsQuery = useGatewayRuns({ filter: { limit: 20 } });
  const programRuns = useMemo(
    () =>
      ((runsQuery.data ?? []) as RunSummary[]).filter((run) => !run.workflowKey || run.workflowKey === WORKFLOW_KEY),
    [runsQuery.data],
  );
  const activeRunId = selectedRunId ?? runIdFromUrl() ?? programRuns[0]?.runId;
  const runDetail = useGatewayRun(activeRunId);
  const activeRun = (runDetail.data as RunSummary | undefined) ?? programRuns.find((run) => run.runId === activeRunId);
  const stream = useGatewayRunEvents(activeRunId, { afterSeq: 0 });
  const events = stream.events;
  const eventCount = events?.length ?? 0;
  const ledger = useMemo(() => buildLedger(events ?? []), [events]);
  const finishedCount = useMemo(
    () => [...ledger.states.values()].filter((state) => state !== "running").length,
    [ledger],
  );

  const manifestQuery = useGatewayNodeOutput({ runId: activeRunId, nodeId: "agui-manifest", iteration: 0 });
  const manifest = useMemo(() => parseManifest(manifestQuery.data), [manifestQuery.data]);
  const finalReport = useGatewayNodeOutput({ runId: activeRunId, nodeId: "agui-final-report", iteration: 0 });
  const reportRow = unwrapRow(finalReport.data);

  // Fixed per-lane result probes (hooks cannot run in a loop; the lane list is
  // static). Used by the coverage-matrix fallback before the audits exist.
  const r0 = useGatewayNodeOutput({ runId: activeRunId, nodeId: "lane-conversation-foundation-result", iteration: 0 });
  const r1 = useGatewayNodeOutput({ runId: activeRunId, nodeId: "lane-prompt-attachments-result", iteration: 0 });
  const r2 = useGatewayNodeOutput({ runId: activeRunId, nodeId: "lane-reasoning-tools-result", iteration: 0 });
  const r3 = useGatewayNodeOutput({ runId: activeRunId, nodeId: "lane-plans-tasks-queues-result", iteration: 0 });
  const r4 = useGatewayNodeOutput({ runId: activeRunId, nodeId: "lane-approvals-checkpoints-result", iteration: 0 });
  const r5 = useGatewayNodeOutput({ runId: activeRunId, nodeId: "lane-sources-citations-result", iteration: 0 });
  const r6 = useGatewayNodeOutput({ runId: activeRunId, nodeId: "lane-agent-identity-context-result", iteration: 0 });
  const r7 = useGatewayNodeOutput({ runId: activeRunId, nodeId: "lane-coding-artifacts-result", iteration: 0 });
  const r8 = useGatewayNodeOutput({ runId: activeRunId, nodeId: "lane-sandbox-previews-result", iteration: 0 });
  const r9 = useGatewayNodeOutput({ runId: activeRunId, nodeId: "lane-workflow-canvas-result", iteration: 0 });
  const r10 = useGatewayNodeOutput({ runId: activeRunId, nodeId: "adopt-chat-result", iteration: 0 });
  const r11 = useGatewayNodeOutput({ runId: activeRunId, nodeId: "adopt-gateway-result", iteration: 0 });
  const r12 = useGatewayNodeOutput({ runId: activeRunId, nodeId: "adopt-product-result", iteration: 0 });
  const resultQueries = [r0, r1, r2, r3, r4, r5, r6, r7, r8, r9, r10, r11, r12];
  const resultRows = useMemo(() => {
    const laneOrder = [...COMPONENT_LANE_IDS, ...ADOPTION_LANE_IDS];
    const map = new Map<string, Record<string, unknown>>();
    laneOrder.forEach((laneId, index) => {
      const row = unwrapRow(resultQueries[index]?.data);
      if (Object.keys(row).length > 0) map.set(laneId, row);
    });
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    r0.data,
    r1.data,
    r2.data,
    r3.data,
    r4.data,
    r5.data,
    r6.data,
    r7.data,
    r8.data,
    r9.data,
    r10.data,
    r11.data,
    r12.data,
  ]);

  const componentLanes = manifest.lanes.filter((lane) => lane.kind === "component");
  const adoptionLanes = manifest.lanes.filter((lane) => lane.kind === "adoption");
  const integrationLane = manifest.lanes.find((lane) => lane.kind === "integration");
  const knownLaneIds =
    manifest.lanes.length > 0
      ? manifest.lanes.map((lane) => lane.laneId)
      : [...COMPONENT_LANE_IDS, ...ADOPTION_LANE_IDS];

  const lanesLgtm = Number(reportRow.lanesLgtm);
  const overall =
    typeof reportRow.success === "boolean"
      ? {
          status: reportRow.success ? "finished" : "failed",
          label: reportRow.success ? "program complete" : "settled incomplete",
        }
      : { status: String(activeRun?.status ?? "waiting"), label: String(activeRun?.status ?? "no run") };

  return (
    <WorkflowUiShell
      title="Agentic UI Library Program"
      meta={activeRunId ? shortRunId(activeRunId) : "No run"}
      actions={
        <>
          <StatusPill data-testid="agui-overall" status={overall.status} label={overall.label} />
          <Button
            variant="outline"
            data-testid="agui-refresh"
            onClick={() => {
              void runsQuery.refetch();
              void runDetail.refetch();
              void manifestQuery.refetch();
              void finalReport.refetch();
              for (const query of resultQueries) void query.refetch();
            }}
          >
            Refresh
          </Button>
        </>
      }
      testId="agui-ui"
    >
      <SmithersUiStyles />
      {activeRunId === undefined ? (
        <EmptyState
          title="No program runs yet."
          description="Start the build-agentic-ui-library workflow to see lanes, reviews, merges and the coverage matrix here."
        />
      ) : (
        <>
          <div data-testid="agui-kpis">
            <KpiStat label="Planned components" value={String(manifest.plannedComponents || "—")} />
            <KpiStat
              label="Component lanes"
              value={`${Number.isFinite(lanesLgtm) ? lanesLgtm : "—"}/${componentLanes.length || 10} lgtm`}
            />
            <KpiStat label="Nodes settled" value={String(finishedCount)} />
            <KpiStat label="Events" value={String(eventCount)} />
          </div>
          <Tabs defaultValue="lanes">
            <TabsList>
              <TabsTrigger value="lanes" count={componentLanes.length || 10}>
                Lanes
              </TabsTrigger>
              <TabsTrigger value="integration">Integration</TabsTrigger>
              <TabsTrigger value="adoption" count={adoptionLanes.length || 3}>
                Multi adoption
              </TabsTrigger>
              <TabsTrigger value="matrix">Coverage matrix</TabsTrigger>
              <TabsTrigger value="activity" count={eventCount}>
                Activity
              </TabsTrigger>
              <TabsTrigger value="runs" count={programRuns.length}>
                Runs
              </TabsTrigger>
            </TabsList>

            <TabsContent value="lanes">
              <SectionHeader title="Design" />
              {(["agui-research", "design-freeze", "design-review"] as const).map((node) => (
                <Card key={node}>
                  <CardHeader>
                    <CardTitle>{node}</CardTitle>
                    <StatusPill status={ledger.states.get(node) ?? "waiting"} />
                  </CardHeader>
                </Card>
              ))}
              <SectionHeader title="Component lanes (OpenCode Kimi 3 implements; Fable/Sol review)" />
              {(componentLanes.length > 0
                ? componentLanes
                : COMPONENT_LANE_IDS.map((laneId) => ({
                    laneId,
                    title: laneId,
                    kind: "component",
                    implementModel: "opencode/kimi-for-coding-k3",
                    reviewSeats: [],
                    components: [],
                  }))
              ).map((lane) => (
                <LaneCard
                  key={lane.laneId}
                  runId={activeRunId}
                  lane={lane}
                  ledger={ledger}
                  refreshKey={finishedCount}
                />
              ))}
            </TabsContent>

            <TabsContent value="integration">
              <SectionHeader title="Serialized merge queue" />
              <MergePanel ledger={ledger} />
              <SectionHeader title="Integration lane (dual review: Fable + Sol)" />
              {(
                [
                  "integration-implement",
                  "integration-ci",
                  "integration-review-fable",
                  "integration-review-sol",
                ] as const
              ).map((node) => (
                <Card key={node}>
                  <CardHeader>
                    <CardTitle>{node}</CardTitle>
                    <StatusPill status={ledger.states.get(node) ?? "waiting"} />
                  </CardHeader>
                </Card>
              ))}
              {integrationLane ? (
                <LaneCard runId={activeRunId} lane={integrationLane} ledger={ledger} refreshKey={finishedCount} />
              ) : null}
              <SectionHeader title="Smithers CI gate output" />
              <NodeOutputView runId={activeRunId} nodeId="integration-ci" />
            </TabsContent>

            <TabsContent value="adoption">
              {(adoptionLanes.length > 0
                ? adoptionLanes
                : ADOPTION_LANE_IDS.map((laneId) => ({
                    laneId,
                    title: laneId,
                    kind: "adoption",
                    implementModel: "opencode/kimi-for-coding-k3",
                    reviewSeats: [],
                    components: [],
                  }))
              ).map((lane) => (
                <LaneCard
                  key={lane.laneId}
                  runId={activeRunId}
                  lane={lane}
                  ledger={ledger}
                  refreshKey={finishedCount}
                />
              ))}
              <SectionHeader title="Multi CI gate" />
              {(["multi-ci", "multi-ci-fix"] as const).map((node) => (
                <Card key={node}>
                  <CardHeader>
                    <CardTitle>{node}</CardTitle>
                    <StatusPill status={ledger.states.get(node) ?? "waiting"} />
                  </CardHeader>
                </Card>
              ))}
              <NodeOutputView runId={activeRunId} nodeId="multi-ci" />
            </TabsContent>

            <TabsContent value="matrix">
              <CoverageMatrix
                runId={activeRunId}
                lanes={manifest.lanes.filter((lane) => lane.components.length > 0)}
                resultRows={resultRows}
                refreshKey={finishedCount}
              />
              <SectionHeader title="Final audits" />
              <AuditCard runId={activeRunId} seat="fable" refreshKey={finishedCount} />
              <AuditCard runId={activeRunId} seat="sol" refreshKey={finishedCount} />
              {asString(reportRow.summary) ? (
                <Card data-testid="agui-final-report">
                  <CardHeader>
                    <CardTitle>Final report</CardTitle>
                    <StatusPill
                      status={reportRow.success === true ? "finished" : "failed"}
                      label={reportRow.success === true ? "success" : "incomplete"}
                    />
                  </CardHeader>
                  <CardContent>
                    <CardDescription>{asString(reportRow.summary)}</CardDescription>
                  </CardContent>
                </Card>
              ) : null}
            </TabsContent>

            <TabsContent value="activity">
              <ApprovalPanel filter={{ runId: activeRunId }} />
              <RunTree
                runId={activeRunId}
                activeNodeId={selectedNodeId}
                onSelectNode={(node) => setSelectedNodeId(node.id)}
              />
              {selectedNodeId ? <NodeOutputView runId={activeRunId} nodeId={selectedNodeId} /> : null}
              <RunEventLog runId={activeRunId} />
            </TabsContent>

            <TabsContent value="runs">
              {programRuns.map((run) => (
                <Button
                  key={run.runId}
                  variant={run.runId === activeRunId ? "default" : "ghost"}
                  data-testid={`agui-run-${run.runId}`}
                  onClick={() => setSelectedRunId(run.runId)}
                >
                  {shortRunId(run.runId)} <StatusPill status={run.status} />
                </Button>
              ))}
              {programRuns.length === 0 ? <EmptyState title="No runs yet." /> : null}
              <SectionHeader title={`Known lanes (${knownLaneIds.length})`} />
              {knownLaneIds.map((laneId) => (
                <Badge key={laneId} variant="muted">
                  {laneId}
                </Badge>
              ))}
            </TabsContent>
          </Tabs>
        </>
      )}
    </WorkflowUiShell>
  );
}

// Mount only on the gateway-served page (a #root element exists there); unit
// tests import the pure helpers without mounting.
if (typeof document !== "undefined" && document.getElementById("root")) {
  createGatewayReactRoot(<AgenticUiProgramApp />);
}
