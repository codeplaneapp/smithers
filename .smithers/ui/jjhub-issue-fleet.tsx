/** @jsxImportSource react */
import { useMemo, useState } from "react";
import { createGatewayReactRoot, useGatewayActions, useGatewayRun, useGatewayRunEvents } from "smthrs/gateway-react";
import { NodeOutputView, RunEventLog, RunTree, WorkflowUiShell } from "smthrs/gateway-ui";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
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
  normalizeStatus,
  statusClass,
} from "smthrs/ui";
import { buildIssueBlitzNodeState, type IssueBlitzNodeStatus as NodeStatus } from "../lib/buildIssueBlitzNodeState";

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
function runIdFromUrl(): string | undefined {
  if (typeof location === "undefined") return undefined;
  return new URLSearchParams(location.search).get("runId") ?? undefined;
}

type LaneRow = { issue: number; title?: string; prUrl?: string; error?: string };

/** Pull per-issue metadata out of node output events so the table is self-describing. */
function collectLanes(events: unknown[]): Map<number, LaneRow> {
  const lanes = new Map<number, LaneRow>();
  for (const event of events as Array<Record<string, any>>) {
    const output = event?.payload?.output ?? event?.output;
    const rows = Array.isArray(output) ? output : [output];
    for (const row of rows) {
      if (!row || typeof row !== "object") continue;
      if (typeof row.issue === "number") {
        const lane: LaneRow = lanes.get(row.issue) ?? { issue: row.issue };
        if (typeof row.prUrl === "string") lane.prUrl = row.prUrl;
        if (typeof row.error === "string") lane.error = row.error;
        lanes.set(row.issue, lane);
      }
      if (Array.isArray(row.issues)) {
        for (const issue of row.issues) {
          if (issue && typeof issue.number === "number") {
            const lane: LaneRow = lanes.get(issue.number) ?? { issue: issue.number };
            if (typeof issue.title === "string") lane.title = issue.title;
            lanes.set(issue.number, lane);
          }
        }
      }
    }
  }
  return lanes;
}

const STAGES = ["lane", "pr", "sandbox", "implement", "cleanup"] as const;

export function JjhubIssueFleetApp() {
  const runId = runIdFromUrl();
  const run = useGatewayRun(runId);
  const { events } = useGatewayRunEvents(runId, { maxEvents: 6000 });
  const { cancelRun } = useGatewayActions();
  const { status, iteration } = useMemo(() => buildIssueBlitzNodeState(events as unknown[]), [events]);
  const lanes = useMemo(() => collectLanes(events as unknown[]), [events]);
  const [selectedNodeId, setSelectedNodeId] = useState<string | undefined>();
  const st = (nodeId: string): NodeStatus => status.get(nodeId) ?? "pending";
  const runStatus = normalizeStatus(asString(run.data?.status)) || "unknown";
  const issueNumbers = [...lanes.keys()].sort((a, b) => a - b);
  const prCount = issueNumbers.filter((issue) => lanes.get(issue)?.prUrl).length;
  const failCount = issueNumbers.filter((issue) => {
    const lane = lanes.get(issue);
    return lane?.error && !lane.prUrl;
  }).length;
  const activeLanes = issueNumbers.filter((issue) =>
    STAGES.some((stage) => statusClass(st(`i${issue}:${stage}`)) === "run"),
  ).length;

  return (
    <WorkflowUiShell
      title="🛰️ jjhub Issue Fleet"
      meta={runId?.slice(0, 8) ?? "--"}
      actions={
        <>
          <StatusPill data-testid="fleet-run-status" status={runStatus} />
          <Button variant="destructive" onClick={() => runId && cancelRun({ runId })}>
            Cancel run
          </Button>
        </>
      }
      testId="jjhub-issue-fleet-ui"
    >
      <SmithersUiStyles />
      <Card>
        <CardHeader>
          <CardTitle>Fleet</CardTitle>
        </CardHeader>
        <CardContent>
          <CardDescription>
            One jjhub sandbox per open smithersai/plue issue · codex gpt-5.6-sol implements in-VM · bookmark push →
            GitHub PR + jjhub landing request
          </CardDescription>
          <StatusPill status={st("discover")} label="discover" />
          <Badge variant="default">{`lanes ${issueNumbers.length}`}</Badge>
          <Badge variant={activeLanes > 0 ? "warning" : "default"}>{`active ${activeLanes}`}</Badge>
          <Badge variant="success">{`PRs ${prCount}`}</Badge>
          <Badge variant={failCount > 0 ? "destructive" : "default"}>{`failed ${failCount}`}</Badge>
          <StatusPill status={st("summary")} label="summary" />
        </CardContent>
      </Card>

      <SectionHeader title="Issue lanes" />
      {issueNumbers.length === 0 ? (
        <EmptyState
          title="Waiting for discovery"
          description="Lanes appear once the open-issue list and jjhub base are resolved."
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Issue</TableHead>
              <TableHead>Sandbox + sol</TableHead>
              <TableHead>PR + landing</TableHead>
              <TableHead>Result</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {issueNumbers.map((issue) => {
              const lane = lanes.get(issue);
              return (
                <TableRow key={issue}>
                  <TableCell>
                    <strong>{`#${issue}`}</strong>
                    <br />
                    {lane?.title ?? ""}
                  </TableCell>
                  <TableCell>
                    <StatusPill status={st(`i${issue}:lane`)} label="vm+sol" />
                  </TableCell>
                  <TableCell>
                    <StatusPill status={st(`i${issue}:pr`)} label="pr" />
                  </TableCell>
                  <TableCell>
                    {lane?.prUrl ? (
                      <a href={lane.prUrl} target="_blank" rel="noreferrer">
                        {lane.prUrl.split("/").slice(-2).join("/")}
                      </a>
                    ) : lane?.error ? (
                      <Badge variant="destructive">{lane.error.slice(0, 80)}</Badge>
                    ) : (
                      <Badge variant="default">in flight</Badge>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}

      <Tabs defaultValue="tree">
        <TabsList>
          <TabsTrigger value="tree">Run tree</TabsTrigger>
          <TabsTrigger value="events" count={(events ?? []).length}>
            Events
          </TabsTrigger>
        </TabsList>
        <TabsContent value="tree">
          <RunTree runId={runId} activeNodeId={selectedNodeId} onSelectNode={(node) => setSelectedNodeId(node.id)} />
          <NodeOutputView
            runId={runId}
            nodeId={selectedNodeId}
            iteration={selectedNodeId ? iteration.get(selectedNodeId) : undefined}
          />
        </TabsContent>
        <TabsContent value="events">
          {runId ? <RunEventLog runId={runId} /> : <EmptyState title="Select a run." />}
        </TabsContent>
      </Tabs>
    </WorkflowUiShell>
  );
}

// Keep this module importable by fixture and parser tests. The gateway-served
// page provides #root; non-browser consumers only need the pure UI module.
if (typeof document !== "undefined" && document.getElementById("root")) {
  createGatewayReactRoot(<JjhubIssueFleetApp />);
}
