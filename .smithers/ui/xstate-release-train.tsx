/** @jsxImportSource react */
import { useMemo } from "react";
import {
  createGatewayReactRoot,
  useGatewayRun,
  useGatewayRunEvents,
  useGatewayRunTree,
} from "smithers-orchestrator/gateway-react";
import {
  WorkflowGraph,
  WorkflowUiShell,
  WorkflowUiStyles,
  type WorkflowSpecNode,
} from "smithers-orchestrator/gateway-ui";
import {
  Badge,
  Card,
  EmptyState,
  SmithersUiStyles,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "smithers-orchestrator/ui";
import {
  approvalDecided,
  computeMachineState,
  eventReceived,
  taskOutput,
  timedOut,
} from "smithers-orchestrator/xstate";
import {
  RELEASE_TRAIN_OUTPUTS,
  releaseTrainMachine,
  releaseTrainStates,
  releaseTrainTransitions,
} from "../components/releaseTrainMachine";

type SnapshotLike = { value: unknown; context: { revision: number } };
type ProvenanceRow = { seq: number; kind: string; type: string };
type DurableRow = { nodeId: string; iteration: number; seq: number; payload: unknown };

function runIdFromUrl(): string | undefined {
  if (typeof location === "undefined") return undefined;
  return new URLSearchParams(location.search).get("runId") ?? undefined;
}

function parseOutput(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/** Which machine state a durable row belongs to, for the visited-state shading. */
function stateForNode(nodeId: string): string {
  if (nodeId === "research") return "researching";
  if (nodeId === "approval") return "awaitingApproval";
  if (nodeId.startsWith("draft")) return "drafting";
  return "waitingForRevision";
}

function sourceKindForNode(nodeId: string): string {
  if (nodeId === "approval") return "approvalDecided";
  if (nodeId.startsWith("revise")) return "timedOut";
  return "taskOutput";
}

function eventTypeForNode(nodeId: string): string {
  if (nodeId === "research") return "RESEARCH_READY";
  if (nodeId === "approval") return "APPROVED / REJECTED";
  if (nodeId.startsWith("revise")) return "TIMEOUT";
  return "DRAFT_READY";
}

/** The statechart, drawn as a graph spec: every state, every transition edge. */
export function releaseTrainGraphSpec(snapshot: SnapshotLike, visited: Set<string>): WorkflowSpecNode[] {
  const active = typeof snapshot.value === "string" ? snapshot.value : "researching";
  return releaseTrainStates.map((state) => ({
    id: state,
    label: state === "waitingForRevision" ? "Waiting for revision" : state,
    kind:
      state === "awaitingApproval"
        ? "approval"
        : state === "waitingForRevision"
          ? "signal"
          : state === "done"
            ? "compute"
            : "agent",
    status: state === active ? "running" : visited.has(state) ? "done" : "pending",
    output: state === active ? "CURRENT" : visited.has(state) ? "visited" : "",
    dependsOn: releaseTrainTransitions.filter(([, , target]) => target === state).map(([source]) => source),
  }));
}

export function ReleaseTrainChart({ snapshot, visited }: { snapshot: SnapshotLike; visited: Set<string> }) {
  return <WorkflowGraph spec={releaseTrainGraphSpec(snapshot, visited)} style={{ height: 450, minHeight: 450 }} />;
}

export function ReleaseTrainApp({ runId = runIdFromUrl() }: { runId?: string } = {}) {
  const run = useGatewayRun(runId);
  const stream = useGatewayRunEvents(runId, { maxEvents: 1000 });
  const tree = useGatewayRunTree(runId);

  const rows: DurableRow[] = useMemo(
    () =>
      tree.nodes
        .filter((node) => node.output)
        .map((node, index) => ({
          nodeId: node.id,
          iteration: node.iteration ?? 0,
          payload: parseOutput(node.output),
          seq: index + 1,
        })),
    [tree.nodes],
  );

  const signals = useMemo(
    () =>
      stream.events
        .filter((frame) => frame.event.includes("signal") && frame.payload)
        .map((frame) => ({ signalName: "REVISE", payload: frame.payload, seq: frame.seq, receivedAtMs: 0 })),
    [stream.events],
  );

  // The same event sources the workflow declares, so the browser folds exactly
  // what the engine folds.
  const events = useMemo(
    () => [
      taskOutput(RELEASE_TRAIN_OUTPUTS.research, { nodeId: "research" }, () => ({ type: "RESEARCH_READY" })),
      approvalDecided(RELEASE_TRAIN_OUTPUTS.approval, { nodeId: "approval" }, (decision: { approved: boolean }) => ({
        type: decision.approved ? "APPROVED" : "REJECTED",
      })),
      taskOutput(RELEASE_TRAIN_OUTPUTS.draft, {}, () => ({ type: "DRAFT_READY" })),
      eventReceived("REVISE", null, {}, () => ({ type: "REVISE" })),
      timedOut(RELEASE_TRAIN_OUTPUTS.wait, {}, () => ({ type: "TIMEOUT" })),
    ],
    [],
  );

  // A ctx-shaped row reader over gateway data. computeMachineState is exposed
  // precisely so tooling can rebuild machine state without a React render.
  const ctx = useMemo(() => {
    const tableFor = (nodeId: string) =>
      nodeId === "research"
        ? RELEASE_TRAIN_OUTPUTS.research
        : nodeId === "approval"
          ? RELEASE_TRAIN_OUTPUTS.approval
          : nodeId.startsWith("revise")
            ? RELEASE_TRAIN_OUTPUTS.wait
            : RELEASE_TRAIN_OUTPUTS.draft;
    return {
      runId: runId ?? "preview",
      outputRows: (output: unknown, options?: { nodeId?: string }) =>
        rows.filter((row) => tableFor(row.nodeId) === output && (!options?.nodeId || row.nodeId === options.nodeId)),
      signalRows: (name: string) => (name === "REVISE" ? signals : []),
    };
  }, [rows, signals, runId]);

  let snapshot: SnapshotLike = { value: "researching", context: { revision: 0 } };
  try {
    snapshot = computeMachineState(ctx, releaseTrainMachine, { id: "release-train", input: run.data, events });
  } catch {
    // The gateway can be between snapshots; keep the last useful chart.
  }

  const visited = new Set<string>(rows.map((row) => stateForNode(row.nodeId)));

  const provenance: ProvenanceRow[] = [
    ...rows.map((row) => ({ seq: row.seq, kind: sourceKindForNode(row.nodeId), type: eventTypeForNode(row.nodeId) })),
    ...signals.map((signal) => ({ seq: signal.seq, kind: "eventReceived", type: "REVISE" })),
  ].sort((a, b) => a.seq - b.seq);

  const status =
    typeof run.data === "object" && run.data !== null && "status" in run.data ? String(run.data.status) : undefined;

  return (
    <WorkflowUiShell
      title="XState Release Train"
      meta={`${runId ?? "preview"} · pure durable-row fold${status ? ` · ${status}` : ""}`}
    >
      <WorkflowUiStyles />
      <SmithersUiStyles />
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) 360px", gap: 16, alignItems: "start" }}>
        <Card>
          <ReleaseTrainChart snapshot={snapshot} visited={visited} />
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, padding: 12 }}>
            {releaseTrainTransitions.map(([from, event, to]) => (
              <Badge key={`${from}-${event}`}>
                {from} — {event} → {to}
              </Badge>
            ))}
          </div>
        </Card>

        <Card>
          <h2 style={{ marginTop: 0 }}>Fold provenance</h2>
          <p style={{ opacity: 0.7 }}>Durable rows, ordered by provenance sequence.</p>
          {provenance.length === 0 ? (
            <EmptyState title="Waiting for durable rows" description="The machine starts in researching." />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>seq</TableHead>
                  <TableHead>source</TableHead>
                  <TableHead>machine event</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {provenance.map((row) => (
                  <TableRow key={`${row.seq}-${row.kind}`}>
                    <TableCell>{row.seq}</TableCell>
                    <TableCell>{row.kind}</TableCell>
                    <TableCell>{row.type}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </Card>
      </div>
    </WorkflowUiShell>
  );
}

if (typeof document !== "undefined") createGatewayReactRoot(<ReleaseTrainApp />);
