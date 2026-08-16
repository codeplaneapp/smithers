/** @jsxImportSource react */
/**
 * pr-review-improve-merge — workflow UI (presentation-only; it cannot schedule work).
 * Declared by the workflow via `UI entry="../ui/pr-review-improve-merge.tsx"`.
 *
 * The pipeline is a short deterministic spine over one PR:
 *   review (legitimacy + improvement list, read-only)
 *   → halt-not-legit (terminal verdict) OR polish loop (improve → rereview)
 *   → merge (deterministic checks poll + squash-merge, gated on approval).
 */
import { useMemo, useState } from "react";
import { createGatewayReactRoot, useGatewayRun, useGatewayRunTree } from "smthrs/gateway-react";
import {
  ConnectionBadge,
  MonitorButton,
  NodeChatStream,
  NodeOutputView,
  RunEventLog,
  RunList,
  RunMeta,
  RunTree,
  WorkflowUiShell,
  nodeStatusIndex,
} from "smthrs/gateway-ui";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
  KpiStat,
  SmithersUiStyles,
  StageStrip,
  StatusPill,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "smthrs/ui";

const WORKFLOW = "pr-review-improve-merge";

// Layout-only rules for this UI. Pack UIs may not use inline style props or
// <style> tags; SmithersUiStyles is the sanctioned per-UI stylesheet seam.
const prReviewImproveMergeStyles =
  ".wf-actions { display:flex; align-items:center; gap:12px; } .wf-body { display:flex; flex-direction:column; gap:12px; padding:16px; } .wf-kpis { display:grid; grid-template-columns:repeat(3, 1fr); gap:12px; } .wf-columns { display:grid; grid-template-columns:260px 1fr 1fr; gap:12px; } .wf-detail { display:flex; flex-direction:column; gap:12px; } @media (max-width: 900px) { .wf-columns { grid-template-columns:1fr; } .wf-kpis { grid-template-columns:1fr; } }";

function runIdFromUrl(): string | undefined {
  if (typeof location === "undefined") return undefined;
  return new URLSearchParams(location.search).get("runId") ?? undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** The deterministic spine, with the not-legit early exit surfaced alongside. */
const STAGES: Array<{ nodeId: string; label: string }> = [
  { nodeId: "review", label: "first review" },
  { nodeId: "improve", label: "improve" },
  { nodeId: "rereview", label: "re-review" },
  { nodeId: "merge", label: "merge" },
];

function PrKpis({ runId }: { runId?: string }) {
  const run = useGatewayRun(runId);
  const tree = useGatewayRunTree(runId);
  const statuses = useMemo(() => nodeStatusIndex(tree.nodes), [tree.nodes]);
  const input = (run.data as { input?: Record<string, unknown> } | undefined)?.input ?? {};
  const pr = typeof input.pr === "number" ? input.pr : undefined;
  const halted = statuses.get("halt-not-legit") === "ok";
  const merged = statuses.get("merge") === "ok";
  const verdict = merged ? "merged" : halted ? "not legit" : (statuses.get("rereview") ?? "pending");
  return (
    <div className="wf-kpis">
      <KpiStat label="Pull request" value={pr !== undefined ? `#${pr}` : "--"} hint="input.pr" />
      <KpiStat
        label="Verdict"
        value={verdict}
        hint={halted ? "first reviewer judged the PR not legit; nothing merged" : "re-review → deterministic merge"}
      />
      <KpiStat label="Run" value={tree.status} hint="live run-tree status" />
    </div>
  );
}

export function PrReviewImproveMergeApp() {
  const [runId, setRunId] = useState<string | undefined>(runIdFromUrl());
  const [nodeId, setNodeId] = useState<string | undefined>();
  const tree = useGatewayRunTree(runId);
  const statuses = useMemo(() => nodeStatusIndex(tree.nodes), [tree.nodes]);
  const run = useGatewayRun(runId);
  const runStatus = asString((run.data as { status?: unknown } | undefined)?.status) ?? tree.status;

  return (
    <WorkflowUiShell
      title="PR Review · Improve · Merge"
      meta={<RunMeta runId={runId} showConnection={false} />}
      actions={
        <div className="wf-actions">
          <StatusPill status={runStatus} label={`run ${runStatus}`} />
          <ConnectionBadge />
          <MonitorButton runId={runId} />
        </div>
      }
      testId="pr-review-improve-merge-ui"
    >
      <SmithersUiStyles extra={prReviewImproveMergeStyles} />
      <div className="wf-body">
        <StageStrip
          stages={STAGES.map((stage) => ({
            label: stage.label,
            status: statuses.get(stage.nodeId) ?? "pending",
          }))}
        />
        {statuses.get("halt-not-legit") !== undefined ? (
          <StatusPill status={statuses.get("halt-not-legit") ?? "pending"} label="halted: not legit" />
        ) : null}
        <PrKpis runId={runId} />

        <div className="wf-columns">
          <RunList
            filter={{ workflow: WORKFLOW, limit: 25 }}
            activeRunId={runId}
            onSelect={(id: string) => {
              setRunId(id);
              setNodeId(undefined);
            }}
          />
          <Tabs defaultValue="tree">
            <TabsList>
              <TabsTrigger value="tree">Run tree</TabsTrigger>
              <TabsTrigger value="events">Events</TabsTrigger>
            </TabsList>
            <TabsContent value="tree">
              <RunTree
                runId={runId}
                activeNodeId={nodeId}
                onSelectNode={(node: { id: string }) => setNodeId(node.id)}
              />
            </TabsContent>
            <TabsContent value="events">
              {runId ? (
                <RunEventLog runId={runId} selectedNodeId={nodeId} onSelectNode={setNodeId} />
              ) : (
                <EmptyState title="Select a run." />
              )}
            </TabsContent>
          </Tabs>
          <div className="wf-detail">
            {nodeId ? (
              <NodeOutputView runId={runId} nodeId={nodeId} />
            ) : (
              <EmptyState
                title="No node selected"
                description="Pick review, improve, rereview, or merge in the tree to see its verdict output and live agent chat."
              />
            )}
            {nodeId ? <NodeChatStream runId={runId} nodeId={nodeId} /> : null}
          </div>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Pipeline contract</CardTitle>
          </CardHeader>
          <CardContent>
            <CardDescription>
              The first review is read-only; improvement commits land only after the PR is judged legit. The merge node
              is deterministic (poll checks ≤ 30 min, squash-merge, verify MERGED via the API) and mounts only after the
              fresh re-reviewer approves — agents cannot fake it.
            </CardDescription>
          </CardContent>
        </Card>
      </div>
    </WorkflowUiShell>
  );
}

// Keep this module importable by fixture and parser tests. The gateway-served
// page provides #root; non-browser consumers only need the pure UI module.
if (typeof document !== "undefined" && document.getElementById("root")) {
  createGatewayReactRoot(<PrReviewImproveMergeApp />);
}
