/** @jsxImportSource react */
import { createGatewayReactRoot, useGatewayNodeOutput, useGatewayRun } from "smithers-orchestrator/gateway-react";
import { ApprovalPanel, RunEventLog, RunTree, WorkflowUiShell } from "smithers-orchestrator/gateway-ui";
import { Card, EmptyState, StatusPill, Tabs, TabsContent, TabsList, TabsTrigger } from "smithers-orchestrator/ui";

const WORKFLOW_KEY = "tui-parity";

// Mirror of the workflow's static PHASES list (ids + titles only).
const PHASES: Array<{ id: string; title: string }> = [
  { id: "boilerplate", title: "1 Boilerplate + rails" },
  { id: "runs", title: "2 Runs list + inspector" },
  { id: "approvals", title: "3 Approvals queue" },
  { id: "chat", title: "4 Chat concierge home" },
  { id: "thin-modes", title: "5 Thin modes" },
  { id: "palette", title: "6 Palette" },
  { id: "hijack", title: "7 Hijack generalized" },
  { id: "custom-tuis", title: "8 Custom TUIs" },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}
function asBool(value: unknown): boolean {
  return value === true;
}
function runIdFromUrl(): string | undefined {
  if (typeof location === "undefined") return undefined;
  return new URLSearchParams(location.search).get("runId") ?? undefined;
}

function stagePill(stage: string): "succeeded" | "failed" | "running" | "pending" {
  if (stage === "landed") return "succeeded";
  if (stage === "checks red" || stage === "review blocked" || stage === "gate denied") return "failed";
  if (stage === "pending") return "pending";
  return "running";
}

function PhaseCard({ runId, phase }: { runId?: string; phase: { id: string; title: string } }) {
  const implOut = useGatewayNodeOutput({ runId, nodeId: `${phase.id}-implement` });
  const checkOut = useGatewayNodeOutput({ runId, nodeId: `${phase.id}-check` });
  const reviewOut = useGatewayNodeOutput({ runId, nodeId: `${phase.id}-review` });
  const mergeOut = useGatewayNodeOutput({ runId, nodeId: `${phase.id}-merge` });
  const postOut = useGatewayNodeOutput({ runId, nodeId: `${phase.id}-post-merge` });
  const gateOut = useGatewayNodeOutput({ runId, nodeId: `gate-${phase.id}` });

  const impl = isRecord(implOut.data) && isRecord(implOut.data.row) ? implOut.data.row : undefined;
  const check = isRecord(checkOut.data) && isRecord(checkOut.data.row) ? checkOut.data.row : undefined;
  const review = isRecord(reviewOut.data) && isRecord(reviewOut.data.row) ? reviewOut.data.row : undefined;
  const merge = isRecord(mergeOut.data) && isRecord(mergeOut.data.row) ? mergeOut.data.row : undefined;
  const post = isRecord(postOut.data) && isRecord(postOut.data.row) ? postOut.data.row : undefined;
  const gate = isRecord(gateOut.data) && isRecord(gateOut.data.row) ? gateOut.data.row : undefined;

  const stage = gate
    ? asBool(gate.approved)
      ? "landed"
      : "gate denied"
    : post
      ? asBool(post.allPassed)
        ? "awaiting gate"
        : "post-merge red"
      : merge
        ? asBool(merge.mergedToMain)
          ? "post-merge checks"
          : "merge failed"
        : review
          ? asBool(review.approved)
            ? "merging"
            : "review blocked"
          : check
            ? asBool(check.allPassed)
              ? "reviewing"
              : "checks red"
            : impl
              ? asString(impl.status) || "implementing"
              : "pending";

  return (
    <Card>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
        <StatusPill status={stagePill(stage)} />
        <strong>{phase.title}</strong>
        <span style={{ opacity: 0.7, fontSize: 13 }}>{stage}</span>
      </div>
      {impl ? <div style={{ marginTop: 8, fontSize: 13 }}>{asString(impl.summary)}</div> : null}
      {check && !asBool(check.allPassed) ? (
        <div style={{ marginTop: 6, fontSize: 13, opacity: 0.85 }}>checks: {asString(check.summary)}</div>
      ) : null}
      {review && !asBool(review.approved) ? (
        <div style={{ marginTop: 6, fontSize: 13, opacity: 0.85 }}>review: {asString(review.feedback)}</div>
      ) : null}
      {merge ? (
        <div style={{ marginTop: 6, fontSize: 13, opacity: 0.7 }}>
          {asString(merge.branch)} · {asString(merge.summary)}
        </div>
      ) : null}
    </Card>
  );
}

function App() {
  const runId = runIdFromUrl();
  const run = useGatewayRun(runId);
  const runStatus = isRecord(run.data) ? asString(run.data.status) : "";
  const resultOut = useGatewayNodeOutput({ runId, nodeId: "tui-parity-result" });
  const result = isRecord(resultOut.data) && isRecord(resultOut.data.row) ? resultOut.data.row : undefined;

  return (
    <WorkflowUiShell
      title="TUI Parity Program"
      meta={
        <>
          <span className="pill">{`${WORKFLOW_KEY} · ${runId ?? "no run"}`}</span>
          {runStatus ? <StatusPill status={runStatus} /> : null}
        </>
      }
    >
      <Tabs defaultValue="phases">
        <TabsList>
          <TabsTrigger value="phases" count={PHASES.length}>
            Phases
          </TabsTrigger>
          <TabsTrigger value="gates">Gates</TabsTrigger>
          <TabsTrigger value="tree">Run tree</TabsTrigger>
          <TabsTrigger value="events">Events</TabsTrigger>
        </TabsList>
        <TabsContent value="phases">
          {runId ? (
            <div style={{ display: "grid", gap: 12 }}>
              {result ? (
                <Card>
                  <strong>Program</strong>
                  <div style={{ fontSize: 13, marginTop: 4 }}>
                    {asString(result.status)} · {asString(result.summary)}
                  </div>
                </Card>
              ) : null}
              {PHASES.map((phase) => (
                <PhaseCard key={phase.id} runId={runId} phase={phase} />
              ))}
            </div>
          ) : (
            <EmptyState title="No run selected" description="Open this UI with ?runId=<id>." />
          )}
        </TabsContent>
        <TabsContent value="gates">
          <ApprovalPanel filter={runId ? { runId } : { workflow: WORKFLOW_KEY }} />
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
