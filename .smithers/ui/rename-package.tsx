/** @jsxImportSource react */
import { createGatewayReactRoot, useGatewayNodeOutput } from "smthrs/gateway-react";
import { RunEventLog, RunTree, WorkflowUiShell } from "smthrs/gateway-ui";
import {
  Card,
  CardHeader,
  CardTitle,
  EmptyState,
  StatusPill,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "smthrs/ui";

const WORKFLOW_KEY = "rename-package";
const LANES = ["packages", "apps-plugin", "pack-examples", "docs"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}
function asStrings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}
function runIdFromUrl(): string | undefined {
  if (typeof location === "undefined") return undefined;
  return new URLSearchParams(location.search).get("runId") ?? undefined;
}

function rowOf(data: unknown): Record<string, unknown> | undefined {
  if (!isRecord(data)) return undefined;
  return isRecord(data.row) ? data.row : data;
}

function pillStatus(status: string): string {
  if (status === "done" || status === "green") return "completed";
  if (status === "partial" || status === "residuals") return "waiting";
  if (status === "blocked") return "failed";
  return "pending";
}

function LaneCard({ runId, lane }: { runId: string; lane: string }) {
  const output = useGatewayNodeOutput({ runId, nodeId: `sweep-${lane}` });
  const row = rowOf(output.data);
  const status = row ? asString(row.status) || "done" : "running";
  const residuals = asStrings(row?.residualHits);
  return (
    <Card>
      <CardHeader>
        <CardTitle>{`Lane: ${lane}`}</CardTitle>
        <StatusPill status={pillStatus(status)} label={status} />
      </CardHeader>
      {row ? (
        <div>
          <p>{asString(row.notes) || "No notes."}</p>
          {residuals.length > 0 ? (
            <ul>
              {residuals.map((hit) => (
                <li key={hit}>{hit}</li>
              ))}
            </ul>
          ) : (
            <p>No residual old-name hits in scope.</p>
          )}
        </div>
      ) : (
        <p>Sweeping…</p>
      )}
    </Card>
  );
}

function FinalizeCard({ runId }: { runId: string }) {
  const output = useGatewayNodeOutput({ runId, nodeId: "finalize" });
  const row = rowOf(output.data);
  if (!row) return <EmptyState title="Finalize pending" description="Runs after all sweep lanes complete." />;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Finalize</CardTitle>
        <StatusPill status={pillStatus(asString(row.status))} label={asString(row.status) || "unknown"} />
      </CardHeader>
      <p>{asString(row.summary)}</p>
      <p>Passed: {asStrings(row.checksPassed).join(", ") || "none reported"}</p>
      <p>Failed: {asStrings(row.checksFailed).join(", ") || "none"}</p>
      {asStrings(row.residualHits).length > 0 ? (
        <ul>
          {asStrings(row.residualHits).map((hit) => (
            <li key={hit}>{hit}</li>
          ))}
        </ul>
      ) : null}
    </Card>
  );
}

function App() {
  const runId = runIdFromUrl();
  if (!runId) {
    return <EmptyState title="No run selected" description={`Open with ?runId=<id> for ${WORKFLOW_KEY}.`} />;
  }
  return (
    <WorkflowUiShell title="Rename npm package" meta={<span className="pill">{`run ${runId}`}</span>}>
      <Tabs defaultValue="lanes">
        <TabsList>
          <TabsTrigger value="lanes">Lanes</TabsTrigger>
          <TabsTrigger value="tree">Run tree</TabsTrigger>
          <TabsTrigger value="events">Events</TabsTrigger>
        </TabsList>
        <TabsContent value="lanes">
          {LANES.map((lane) => (
            <LaneCard key={lane} runId={runId} lane={lane} />
          ))}
          <FinalizeCard runId={runId} />
        </TabsContent>
        <TabsContent value="tree">
          <RunTree runId={runId} />
        </TabsContent>
        <TabsContent value="events">
          <RunEventLog runId={runId} />
        </TabsContent>
      </Tabs>
    </WorkflowUiShell>
  );
}

createGatewayReactRoot(<App />);
