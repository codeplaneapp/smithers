/** @jsxImportSource react */
/**
 * serverless-refactor — workflow UI (presentation-only; it cannot schedule work).
 * Declared by the workflow via `UI entry="../ui/serverless-refactor.tsx"`.
 *
 * One row per refactor task (its own worktree + branch serverless/<id>): Sol
 * plan panel → ValidationLoop (Luna implement → Terra validate → Sol review
 * panel + synthesis) → exactly one PR when approved. Tasks run sequentially by
 * default because they are dependent (merge a phase's PR before its dependents).
 */
import { useMemo, useState } from "react";
import { createGatewayReactRoot, useGatewayRunTree } from "smthrs/gateway-react";
import {
  ConnectionBadge,
  FleetTable,
  MonitorButton,
  NodeChatStream,
  NodeOutputView,
  RunEventLog,
  RunList,
  RunMeta,
  RunTree,
  StatusPill,
  WorkflowUiShell,
  nodeStatusIndex,
} from "smthrs/gateway-ui";
import { EmptyState, KpiStat, SmithersUiStyles, Tabs, TabsContent, TabsList, TabsTrigger } from "smthrs/ui";

const WORKFLOW = "serverless-refactor";

// Layout-only rules for this UI. Pack UIs may not use inline style props or
// <style> tags; SmithersUiStyles is the sanctioned per-UI stylesheet seam.
const serverlessRefactorStyles =
  ".wf-actions { display:flex; align-items:center; gap:12px; } .wf-body { display:flex; flex-direction:column; gap:12px; padding:16px; } .wf-kpis { display:grid; grid-template-columns:repeat(3, 1fr); gap:12px; } .wf-columns { display:grid; grid-template-columns:260px 1fr 1fr; gap:12px; } .wf-detail { display:flex; flex-direction:column; gap:12px; } @media (max-width: 900px) { .wf-columns { grid-template-columns:1fr; } .wf-kpis { grid-template-columns:1fr; } }";

/** Mirrors DEFAULT_TASKS in the workflow: id, phase, short title. */
const TASKS: Array<{ id: string; phase: string; title: string }> = [
  { id: "1b-platform-layer", phase: "1 · platform", title: "Injectable platform layer (drop hard-bound Bun globals)" },
  { id: "1b2-node-runtime-smoke", phase: "1 · platform", title: "Prove the engine drives a run under plain node" },
  { id: "1c-command-seam", phase: "1 · platform", title: "Route subprocess spawning through @effect/platform Command" },
  { id: "1d-i-engine-fs", phase: "1 · platform", title: "Engine-core node:fs behind FileSystem" },
  { id: "1d-ii-engine-periphery-fs", phase: "1 · platform", title: "Engine-periphery node:fs + node:net seams" },
  { id: "1d-iii-sandbox-server-fs", phase: "1 · platform", title: "Sandbox-host + server node:fs seams" },
  { id: "1e-gateway-fetch-adapter", phase: "1 · platform", title: "fetch-handler adapter for the gateway" },
  { id: "2a-cf-worker-driver", phase: "2 · cloudflare", title: "Worker entry + Durable Object alarm-driven driver" },
  {
    id: "2b-cf-sandbox-provider-harness",
    phase: "2 · cloudflare",
    title: "In-container harness + keepAlive lifecycle",
  },
  { id: "2c-graceful-degrade", phase: "2 · cloudflare", title: "Capability flags degrade non-serverless features" },
  { id: "3a-vercel-example-rebuild", phase: "3 · hosts", title: "Rebuild the Vercel example into a real showcase" },
  { id: "3b-node-host-examples-docs", phase: "3 · hosts", title: "AWS/GCP/Kubernetes Node-host guides + cost model" },
  { id: "4a-dual-surface-e2e", phase: "4 · proof", title: "Dual-surface e2e: Workers isolate + sandbox container" },
  { id: "4b-fluency-evals", phase: "4 · proof", title: "Haiku one-shot deploy-setup fluency evals" },
];

/** Mirrors the workflow's slugify(): kebab-case, 50-char cap. */
function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 50) || "task"
  );
}

function nodeIdsFor(taskId: string): string[] {
  const key = `t-${slugify(taskId)}`;
  return [`${key}:plan-moderator`, `${key}:implement`, `${key}:validate`, `${key}:review-moderator`, `${key}:pr`];
}

function runIdFromUrl(): string | undefined {
  if (typeof location === "undefined") return undefined;
  return new URLSearchParams(location.search).get("runId") ?? undefined;
}

export function ServerlessRefactorApp() {
  const [runId, setRunId] = useState<string | undefined>(runIdFromUrl());
  const [selected, setSelected] = useState<string | undefined>();
  const [nodeId, setNodeId] = useState<string | undefined>();
  const tree = useGatewayRunTree(runId);
  const statuses = useMemo(() => nodeStatusIndex(tree.nodes), [tree.nodes]);

  const prOpened = TASKS.filter((task) => statuses.get(`t-${slugify(task.id)}:pr`) === "ok").length;
  const approved = TASKS.filter((task) => statuses.get(`t-${slugify(task.id)}:review-moderator`) === "ok").length;

  const detailNodeId = nodeId ?? (selected ? `t-${slugify(selected)}:review-moderator` : undefined);

  return (
    <WorkflowUiShell
      title="Serverless Refactor — Sol plan/review → Luna implement → Terra validate/PR"
      meta={<RunMeta runId={runId} showConnection={false} />}
      actions={
        <div className="wf-actions">
          <StatusPill status={tree.status} label={`run ${tree.status}`} />
          <ConnectionBadge />
          <MonitorButton runId={runId} />
        </div>
      }
      testId="serverless-refactor-ui"
    >
      <SmithersUiStyles extra={serverlessRefactorStyles} />
      <div className="wf-body">
        <div className="wf-kpis">
          <KpiStat label="Tasks approved" value={`${approved}/${TASKS.length}`} hint="Sol review synthesis approved" />
          <KpiStat label="PRs opened" value={String(prOpened)} hint="one PR per isolated task, off main" />
          <KpiStat label="Lanes" value={String(TASKS.length)} hint="sequential by default; dependent tasks" />
        </div>

        <div className="wf-columns">
          <RunList
            filter={{ workflow: WORKFLOW, limit: 25 }}
            activeRunId={runId}
            onSelect={(id: string) => {
              setRunId(id);
              setSelected(undefined);
              setNodeId(undefined);
            }}
          />
          <FleetTable
            runId={runId}
            titleColumn="refactor task"
            columns={["phase"]}
            statusColumn="pipeline"
            items={TASKS.map((task) => ({
              key: task.id,
              title: task.title,
              meta: [task.phase],
              nodeIds: nodeIdsFor(task.id),
            }))}
            selectedKey={selected}
            onSelect={(key) => {
              setSelected(key);
              setNodeId(undefined);
            }}
          />
          <div className="wf-detail">
            {detailNodeId && runId ? (
              <NodeOutputView runId={runId} nodeId={detailNodeId} />
            ) : (
              <EmptyState
                title="No task selected"
                description="Pick a refactor task to inspect its synthesized plan, validation, review verdict, and PR."
              />
            )}
            {detailNodeId && runId ? <NodeChatStream runId={runId} nodeId={detailNodeId} /> : null}
          </div>
        </div>

        <Tabs defaultValue="tree">
          <TabsList>
            <TabsTrigger value="tree">Run tree</TabsTrigger>
            <TabsTrigger value="events">Events</TabsTrigger>
          </TabsList>
          <TabsContent value="tree">
            <RunTree
              runId={runId}
              activeNodeId={nodeId}
              onSelectNode={(node: { id: string }) => {
                setNodeId(node.id);
              }}
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
      </div>
    </WorkflowUiShell>
  );
}

// Keep this module importable by fixture and parser tests. The gateway-served
// page provides #root; non-browser consumers only need the pure UI module.
if (typeof document !== "undefined" && document.getElementById("root")) {
  createGatewayReactRoot(<ServerlessRefactorApp />);
}
