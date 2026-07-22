/** @jsxImportSource react */
import { useMemo } from "react";
import {
  createGatewayReactRoot,
  useGatewayNodeOutput,
  useGatewayRun,
} from "smithers-orchestrator/gateway-react";
import { RunEventLog, RunTree, WorkflowUiShell } from "smithers-orchestrator/gateway-ui";
import { Card, EmptyState, StatusPill, Tabs, TabsContent, TabsList, TabsTrigger } from "smithers-orchestrator/ui";

const WORKFLOW_KEY = "audit-fix-train";

type Finding = {
  priority: number;
  title: string;
  group: string;
  dimension: string;
  severity: string;
  rationale: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}
function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
function asBool(value: unknown): boolean {
  return value === true;
}
function runIdFromUrl(): string | undefined {
  if (typeof location === "undefined") return undefined;
  return new URLSearchParams(location.search).get("runId") ?? undefined;
}

/** Mirror of the workflow's slugify so lane node ids can be derived from input alone. */
function slugify(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized.length > 0 ? normalized : "item";
}

function findingsFromRun(runData: unknown): Finding[] {
  const run = isRecord(runData) ? runData : {};
  const input = isRecord(run.input) ? run.input : isRecord(run.inputs) ? run.inputs : {};
  const raw = Array.isArray(input.findings) ? input.findings : [];
  return raw.filter(isRecord).map((f, idx) => ({
    priority: asNumber(f.priority) || idx + 1,
    title: asString(f.title),
    group: asString(f.group),
    dimension: asString(f.dimension),
    severity: asString(f.severity) || "medium",
    rationale: asString(f.rationale),
  }));
}

function severityTone(severity: string): "danger" | "warning" | "neutral" {
  if (severity === "critical" || severity === "high") return "danger";
  if (severity === "medium") return "warning";
  return "neutral";
}

function LaneCard({ runId, finding, index }: { runId?: string; finding: Finding; index: number }) {
  const base = `f${finding.priority || index + 1}-${slugify(finding.title)}`;
  // Node ids are `<workItemId>:<stage>` (the workflow suffixes the stage), not `<stage>:<workItemId>`.
  const implOut = useGatewayNodeOutput({ runId, nodeId: `${base}:implement` });
  const reviewOut = useGatewayNodeOutput({ runId, nodeId: `${base}:review` });
  const mergeOut = useGatewayNodeOutput({ runId, nodeId: `${base}:merge` });

  const impl = isRecord(implOut.data) ? implOut.data : undefined;
  const review = isRecord(reviewOut.data) ? reviewOut.data : undefined;
  const merge = isRecord(mergeOut.data) ? mergeOut.data : undefined;

  const landed = merge ? asString(merge.status) === "merged" && asBool(merge.verified) : false;
  const stage = merge ? asString(merge.status) : review ? (asBool(review.approved) ? "approved" : "changes requested") : impl ? asString(impl.status) : "pending";

  return (
    <Card>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
        <StatusPill status={landed ? "succeeded" : merge ? "failed" : impl ? "running" : "pending"} />
        <strong>
          #{finding.priority} {finding.title}
        </strong>
        <StatusPill status={severityTone(finding.severity) === "danger" ? "failed" : "pending"} label={finding.severity} />
      </div>
      <div style={{ opacity: 0.75, fontSize: 13, marginTop: 4 }}>
        {finding.group} · {finding.dimension} · stage: {stage}
      </div>
      {impl ? (
        <div style={{ marginTop: 8, fontSize: 13 }}>
          <div>{asString(impl.summary)}</div>
          <div style={{ opacity: 0.7, marginTop: 4 }}>
            test: {asString(impl.testAdded) || "(none reported)"} · files:{" "}
            {(Array.isArray(impl.filesChanged) ? impl.filesChanged.length : 0)}
          </div>
        </div>
      ) : null}
      {review && !asBool(review.approved) ? (
        <div style={{ marginTop: 8, fontSize: 13, opacity: 0.85 }}>reviewer: {asString(review.feedback)}</div>
      ) : null}
      {merge ? (
        <div style={{ marginTop: 8, fontSize: 13, opacity: 0.85 }}>
          land: {asString(merge.status)} · gate {asBool(merge.gatePassed) ? "green" : "red"} · {asString(merge.summary)}
        </div>
      ) : null}
    </Card>
  );
}

function App() {
  const runId = runIdFromUrl();
  const run = useGatewayRun(runId);
  const findings = useMemo(() => findingsFromRun(run.data), [run.data]);
  const pushOut = useGatewayNodeOutput({ runId, nodeId: "push" });
  const push = isRecord(pushOut.data) ? pushOut.data : undefined;

  const runStatus = isRecord(run.data) ? asString(run.data.status) : "";

  return (
    <WorkflowUiShell
      title="Audit Fix Train"
      meta={
        <>
          <span className="pill">{`${WORKFLOW_KEY} · ${runId ?? "no run"}`}</span>
          {runStatus ? <StatusPill status={runStatus} /> : null}
        </>
      }
    >
      <Tabs defaultValue="lanes">
        <TabsList>
          <TabsTrigger value="lanes" count={findings.length}>
            Fix lanes
          </TabsTrigger>
          <TabsTrigger value="tree">Run tree</TabsTrigger>
          <TabsTrigger value="events">Events</TabsTrigger>
        </TabsList>
        <TabsContent value="lanes">
          {findings.length === 0 ? (
            <EmptyState title="No findings yet" description="Waiting for the run input to load." />
          ) : (
            <div style={{ display: "grid", gap: 12 }}>
              {findings.map((f, i) => (
                <LaneCard key={`${f.priority}-${f.title}`} runId={runId} finding={f} index={i} />
              ))}
              {push ? (
                <Card>
                  <strong>Push stage</strong>
                  <div style={{ fontSize: 13, marginTop: 4 }}>
                    {asString(push.status)} · main green: {asBool(push.mainGreen) ? "yes" : "no"} ·{" "}
                    {asString(push.summary)}
                  </div>
                </Card>
              ) : null}
            </div>
          )}
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
