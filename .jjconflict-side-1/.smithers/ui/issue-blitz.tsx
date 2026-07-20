/** @jsxImportSource react */
import { useMemo, useState } from "react";
import {
  createGatewayReactRoot,
  useGatewayActions,
  useGatewayRun,
  useGatewayRunEvents,
} from "smithers-orchestrator/gateway-react";
import { NodeOutputView, RunEventLog, RunTree } from "smithers-orchestrator/gateway-ui";
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
  isTerminalRunStatus,
  normalizeStatus,
  statusClass,
} from "smithers-orchestrator/ui";
import {
  buildIssueBlitzNodeState,
  type IssueBlitzNodeStatus as NodeStatus,
} from "../lib/buildIssueBlitzNodeState";

const ITEMS: Array<{ key: string; kind: "hard" | "quick"; issues: number[]; title: string }> = [
  { key: "ci-postgres", kind: "hard", issues: [1331], title: "CI test-postgres red (PGlite migrate suites)" },
  { key: "e2e-orphans", kind: "hard", issues: [1332], title: "e2e harness leaks orphaned smithers up processes" },
  { key: "dual-react", kind: "hard", issues: [1333], title: "Gateway dual React instances at render" },
  { key: "url-schemes", kind: "quick", issues: [799, 911, 912], title: "Reject non-HTTP URL schemes (file:// exposure)" },
  { key: "pack-home", kind: "quick", issues: [1322], title: "Pack global root ignores env.HOME" },
  { key: "pack-scan", kind: "quick", issues: [1323], title: "Pack import scanner misses .js helpers" },
  { key: "workflow-dirs", kind: "quick", issues: [1324], title: "resolveWorkflowDirs local==global collapse" },
  { key: "dead-code", kind: "quick", issues: [1327], title: "Delete dead autoOpenMonitor" },
  { key: "mcp-confirm", kind: "quick", issues: [861, 862], title: "Confirmation for restore_checkpoint / time_travel" },
  { key: "coerce-props", kind: "quick", issues: [865, 866, 867], title: "Coerce numeric-string props in graph extraction" },
  { key: "audit-atomic", kind: "quick", issues: [872, 873, 874, 875, 876, 877, 878, 879, 880], title: "Atomic mutation + audit-event writes (×9)" },
];

function asString(value: unknown): string | undefined { return typeof value === "string" ? value : undefined; }
function runIdFromUrl(): string | undefined {
  if (typeof location === "undefined") return undefined;
  return new URLSearchParams(location.search).get("runId") ?? undefined;
}
function SummaryCard({ title, runId, nodeId, iteration, state }: { title: string; runId?: string; nodeId: string; iteration: number; state: NodeStatus }) {
  return <Card><CardHeader><CardTitle>{title}</CardTitle><StatusPill status={state} /></CardHeader><CardContent><NodeOutputView runId={runId} nodeId={nodeId} iteration={iteration} /></CardContent></Card>;
}

export function IssueBlitzApp() {
  const runId = runIdFromUrl();
  const run = useGatewayRun(runId);
  const { events } = useGatewayRunEvents(runId, { maxEvents: 4000 });
  const { cancelRun } = useGatewayActions();
  const { status, iteration } = useMemo(() => buildIssueBlitzNodeState(events as unknown[]), [events]);
  const [selectedNodeId, setSelectedNodeId] = useState<string | undefined>();
  const st = (nodeId: string): NodeStatus => status.get(nodeId) ?? "pending";
  const runStatus = normalizeStatus(asString(run.data?.status)) || "unknown";
  const doneItems = ITEMS.filter((item) => st(`${item.key}:ready`) === "done").length;
  const isolatedStatus = doneItems === ITEMS.length
    ? "done"
    : ITEMS.some((item) => ["bootstrap", "plan", "implement", "review"]
      .some((stage) => statusClass(st(`${item.key}:${stage}`)) === "run"))
      ? "running"
      : "pending";
  const terminal = (nodeId: string) => isTerminalRunStatus(st(nodeId));
  const stages: Array<[string, NodeStatus]> = [
    ["discover", st("discover")], ["serial integration", st("commit-all")], ["sandboxed gate", st("local-gate")],
    ["review (fable)", st("fable-review")], ["human approval", st("approve-push")], ["exact-SHA push", st("push")],
  ];

  return <main aria-label="Issue Blitz workflow dashboard" data-testid="issue-blitz-ui">
    <SmithersUiStyles />
    <SectionHeader title="⚡ Issue Blitz" eyebrow={runId?.slice(0, 8) ?? "--"} actions={<><StatusPill data-testid="issue-blitz-run-status" status={runStatus} /><Button variant="destructive" onClick={() => runId && cancelRun({ runId })}>Cancel run</Button></>}>
      {doneItems}/{ITEMS.length} isolated lanes settled · exact candidate review → serial integration → sandboxed gate → human-approved exact-SHA push
    </SectionHeader>
    <Card><CardHeader><CardTitle>Delivery stages</CardTitle></CardHeader><CardContent>{stages.map(([label, state]) => <StatusPill key={label} status={state} label={label} />)}<StatusPill data-testid="issue-blitz-isolated-status" status={isolatedStatus} label={`isolated worktrees ×${ITEMS.length}`} /></CardContent></Card>
    <SectionHeader title="Isolated lanes" />
    <Table><TableHeader><TableRow><TableHead>Item</TableHead><TableHead>Issues</TableHead><TableHead>Implementer</TableHead><TableHead>Plan</TableHead><TableHead>Implement</TableHead><TableHead>Snapshot</TableHead><TableHead>Exact review</TableHead><TableHead>Ready</TableHead><TableHead>Iter</TableHead></TableRow></TableHeader><TableBody>{ITEMS.map((item) => <TableRow key={item.key}><TableCell><strong>{item.key}</strong><br />{item.title}</TableCell><TableCell>{item.issues.map((number) => `#${number}`).join(" ")}</TableCell><TableCell><Badge variant={item.kind === "hard" ? "warning" : "default"}>{item.kind === "hard" ? "terra" : "luna"}</Badge></TableCell><TableCell><StatusPill status={st(`${item.key}:plan`)} label="plan" /></TableCell><TableCell><StatusPill status={st(`${item.key}:implement`)} label="impl" /></TableCell><TableCell><StatusPill status={st(`${item.key}:candidate`)} label="sha" /></TableCell><TableCell><StatusPill status={st(`${item.key}:review`)} label="review" /></TableCell><TableCell><StatusPill status={st(`${item.key}:ready`)} label="ready" /></TableCell><TableCell>{(iteration.get(`${item.key}:implement`) ?? 0) + 1}</TableCell></TableRow>)}</TableBody></Table>
    {terminal("commit-all") ? <SummaryCard title="Serialized integration" runId={runId} nodeId="commit-all" iteration={iteration.get("commit-all") ?? 0} state={st("commit-all")} /> : null}
    {terminal("local-gate") ? <SummaryCard title="Sandboxed local gate" runId={runId} nodeId="local-gate" iteration={iteration.get("local-gate") ?? 0} state={st("local-gate")} /> : null}
    {terminal("fable-review") ? <SummaryCard title="Fable exact-head review" runId={runId} nodeId="fable-review" iteration={iteration.get("fable-review") ?? 0} state={st("fable-review")} /> : null}
    {terminal("approve-push") ? <SummaryCard title="Human publication decision" runId={runId} nodeId="approve-push" iteration={iteration.get("approve-push") ?? 0} state={st("approve-push")} /> : null}
    {terminal("push") ? <SummaryCard title="Exact-SHA publication" runId={runId} nodeId="push" iteration={iteration.get("push") ?? 0} state={st("push")} /> : null}
    <Tabs defaultValue="tree"><TabsList><TabsTrigger value="tree">Run tree</TabsTrigger><TabsTrigger value="events" count={(events ?? []).length}>Events</TabsTrigger></TabsList><TabsContent value="tree"><RunTree runId={runId} activeNodeId={selectedNodeId} onSelectNode={(node) => setSelectedNodeId(node.id)} /><NodeOutputView runId={runId} nodeId={selectedNodeId} iteration={selectedNodeId ? iteration.get(selectedNodeId) : undefined} /></TabsContent><TabsContent value="events">{runId ? <RunEventLog runId={runId} /> : <EmptyState title="Select a run." />}</TabsContent></Tabs>
  </main>;
}

// Keep this module importable by fixture and parser tests. The gateway-served
// page provides #root; non-browser consumers only need the pure UI module.
if (typeof document !== "undefined" && document.getElementById("root")) {
  createGatewayReactRoot(<IssueBlitzApp />);
}
