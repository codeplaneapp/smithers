/** @jsxImportSource react */
/**
 * test-fortress — workflow UI (presentation-only; it cannot schedule work).
 * Declared by the workflow via `UI entry="../ui/test-fortress.tsx"`.
 *
 * Phases:
 *   1. Discovery swarm (tf:discover:<shard>) + merge (tf:discover:merge) find
 *      features missing from features.ts.
 *   2. Two tracks (unit, e2e) run per-group debate loops
 *      (tf:<track>:<group>:harden → gap → for → against → judge) until the
 *      judge calls the remaining gaps trivial.
 *   3. A Codex loop (tf:codex:fix → tf:codex:review) reviews the whole tree
 *      until LGTM, then tf:result reports the verdict.
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
import {
  EmptyState,
  KpiStat,
  SectionHeader,
  SmithersUiStyles,
  StageStrip,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "smthrs/ui";

const WORKFLOW = "test-fortress";

// Layout-only rules for this UI. Pack UIs may not use inline style props or
// <style> tags; SmithersUiStyles is the sanctioned per-UI stylesheet seam.
const testFortressStyles =
  ".wf-actions { display:flex; align-items:center; gap:12px; } .wf-body { display:flex; flex-direction:column; gap:12px; padding:16px; } .wf-kpis { display:grid; grid-template-columns:repeat(3, 1fr); gap:12px; } .wf-columns { display:grid; grid-template-columns:260px 1fr 1fr; gap:12px; } .wf-detail { display:flex; flex-direction:column; gap:12px; } @media (max-width: 900px) { .wf-columns { grid-template-columns:1fr; } .wf-kpis { grid-template-columns:1fr; } }";

/** The fixed spine around the dynamic per-group loops. */
const SPINE: Array<{ nodeId: string; label: string }> = [
  { nodeId: "tf:discover:merge", label: "discovery merge" },
  { nodeId: "tf:codex:fix", label: "codex fix" },
  { nodeId: "tf:codex:review", label: "codex review" },
  { nodeId: "tf:result", label: "result" },
];

const TRACK_STAGES = ["harden", "gap", "for", "against", "judge"] as const;

function runIdFromUrl(): string | undefined {
  if (typeof location === "undefined") return undefined;
  return new URLSearchParams(location.search).get("runId") ?? undefined;
}

/** Group the live tree rows into per-(track, group) debate loops. */
function useTrackGroups(runId: string | undefined) {
  const tree = useGatewayRunTree(runId);
  return useMemo(() => {
    const groups = new Map<string, { track: string; group: string }>();
    for (const node of tree.nodes) {
      const id = typeof node.id === "string" ? node.id : "";
      const match = /^tf:(unit|e2e):([^:]+):(.+)$/.exec(id);
      if (!match) continue;
      const [, track, group] = match;
      if (!groups.has(`${track}:${group}`)) groups.set(`${track}:${group}`, { track: track!, group: group! });
    }
    return {
      tree,
      groups: [...groups.values()].sort((a, b) => `${a.track}:${a.group}`.localeCompare(`${b.track}:${b.group}`)),
    };
  }, [tree]);
}

export function TestFortressApp() {
  const [runId, setRunId] = useState<string | undefined>(runIdFromUrl());
  const [selected, setSelected] = useState<string | undefined>();
  const [nodeId, setNodeId] = useState<string | undefined>();
  const { tree, groups } = useTrackGroups(runId);
  const statuses = useMemo(() => nodeStatusIndex(tree.nodes), [tree.nodes]);

  const judged = groups.filter((g) => statuses.get(`tf:${g.track}:${g.group}:judge`) === "ok").length;
  const codexApproved = statuses.get("tf:codex:review") === "ok";

  const detailNodeId = nodeId ?? (selected ? `tf:${selected}:judge` : undefined);

  return (
    <WorkflowUiShell
      title="Test Fortress — discovery swarm → debate loops → Codex LGTM"
      meta={<RunMeta runId={runId} showConnection={false} />}
      actions={
        <div className="wf-actions">
          <StatusPill status={tree.status} label={`run ${tree.status}`} />
          <ConnectionBadge />
          <MonitorButton runId={runId} />
        </div>
      }
      testId="test-fortress-ui"
    >
      <SmithersUiStyles extra={testFortressStyles} />
      <div className="wf-body">
        <StageStrip
          stages={SPINE.map((stage) => ({
            label: stage.label,
            status: statuses.get(stage.nodeId) ?? "pending",
          }))}
        />
        <div className="wf-kpis">
          <KpiStat label="Debate loops" value={String(groups.length)} hint="unit + e2e feature groups" />
          <KpiStat
            label="Judged"
            value={`${judged}/${groups.length}`}
            hint="judge settled (trivial or rounds exhausted)"
          />
          <KpiStat
            label="Codex review"
            value={codexApproved ? "LGTM" : (statuses.get("tf:codex:review") ?? "pending")}
          />
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
          <div>
            <SectionHeader title="Feature-group debate loops" />
            {groups.length === 0 ? (
              <EmptyState
                title="No groups yet"
                description="Groups appear after the discovery swarm and merge name the features missing from features.ts."
              />
            ) : (
              <FleetTable
                runId={runId}
                titleColumn="feature group"
                columns={["track"]}
                statusColumn="debate loop"
                items={groups.map((g) => ({
                  key: `${g.track}:${g.group}`,
                  title: g.group,
                  meta: [g.track],
                  nodeIds: TRACK_STAGES.map((stage) => `tf:${g.track}:${g.group}:${stage}`),
                }))}
                selectedKey={selected}
                onSelect={(key) => {
                  setSelected(key);
                  setNodeId(undefined);
                }}
              />
            )}
          </div>
          <div className="wf-detail">
            {detailNodeId && runId ? (
              <NodeOutputView runId={runId} nodeId={detailNodeId} />
            ) : (
              <EmptyState
                title="No loop selected"
                description="Pick a feature group to inspect its judge verdict, or a spine node for the Codex review."
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
  createGatewayReactRoot(<TestFortressApp />);
}
