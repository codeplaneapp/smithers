/** @jsxImportSource react */
import { useEffect, useMemo } from "react";
import {
  createGatewayReactRoot,
  useGatewayMemoryFacts,
  useGatewayRun,
  useGatewayRunEvents,
  useGatewayRunTree,
} from "smithers-orchestrator/gateway-react";
import { RunEventLog, RunTree, WorkflowUiShell } from "smithers-orchestrator/gateway-ui";
import {
  Badge,
  Card,
  CollapsiblePanel,
  EmptyState,
  Markdown,
  SmithersUiStyles,
  StageStrip,
  StatusPill,
  Table,
  TableBody,
  TableCell,
  TableRow,
} from "smithers-orchestrator/ui";

export type MemoryConfig = {
  bank?: string;
  banks?: string[];
  tags?: string[];
  recall?: "auto" | string | false;
  budget?: "low" | "mid" | "high";
  maxTokens?: number;
  primers?: string[];
  retain?: "on-complete" | "off";
  tools?: boolean;
};

export type GatewayNode = {
  id: string;
  name: string;
  status: string;
  meta?: string;
  output?: string;
  toolCalls?: ReadonlyArray<Record<string, unknown>>;
};

export type GatewayEvent = {
  event: string;
  payload?: unknown;
  seq: number;
};

export type MemoryFact = {
  namespace: string;
  key: string;
  valueJson: string;
};

export type LifecycleRow = {
  nodeId: string;
  label: string;
  mode: string;
  status: string;
  config?: MemoryConfig;
  recallQuery?: string;
  recalledBlocks?: string[];
  primerIds?: string[];
  recallTokenCost?: number;
  toolCalls: string[];
  digest?: string;
};

const TASKS: Record<string, { label: string; mode: string }> = {
  triage: { label: "Triage incident", mode: "inherited" },
  investigation: { label: "Investigate known issue", mode: "overridden" },
  "customer-response": { label: "Write customer response", mode: "opted out" },
};

function runIdFromUrl(): string | undefined {
  if (typeof location === "undefined") {
    return undefined;
  }
  return new URLSearchParams(location.search).get("runId") ?? undefined;
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function eventName(event: string): string {
  return event.replaceAll("_", "").toLowerCase();
}

function nodeIdForEvent(event: GatewayEvent): string | undefined {
  const payload = recordValue(event.payload);
  return typeof payload?.nodeId === "string" ? payload.nodeId : undefined;
}

function configFromNode(node: GatewayNode): MemoryConfig | undefined {
  const meta = recordValue(parseJson(node.meta));
  const config = recordValue(meta?.memoryConfig);
  return config as MemoryConfig | undefined;
}

function digestForTask(
  facts: ReadonlyArray<MemoryFact>,
  runId: string | undefined,
  nodeId: string,
): string | undefined {
  if (!runId) {
    return undefined;
  }
  const key = `memory:smithers-run-${runId}`;
  const fact = facts.find(
    (candidate) => candidate.key === key && candidate.namespace === "workflow:support-triage-demo",
  );
  const value = recordValue(parseJson(fact?.valueJson));
  const content = typeof value?.content === "string" ? value.content : undefined;
  if (!content) {
    return undefined;
  }
  const start = content.indexOf(`Task ${nodeId} completed successfully.`);
  if (start < 0) {
    return undefined;
  }
  const next = content.indexOf("\nTask ", start + 1);
  return content.slice(start, next < 0 ? content.length : next).trim();
}

function toolNamesFromNode(node: GatewayNode): string[] {
  return [
    ...new Set(
      (node.toolCalls ?? [])
        .map((call) => call.toolName)
        .filter((tool): tool is string => tool === "remember" || tool === "recall"),
    ),
  ];
}

export function deriveMemoryLifecycle(
  nodes: ReadonlyArray<GatewayNode>,
  events: ReadonlyArray<GatewayEvent>,
  facts: ReadonlyArray<MemoryFact>,
  runId?: string,
): LifecycleRow[] {
  return Object.entries(TASKS)
    .map(([nodeId, task]) => {
      const node = nodes.find((candidate) => candidate.id === nodeId);
      if (!node) {
        return undefined;
      }
      const taskEvents = events.filter((event) => nodeIdForEvent(event) === nodeId);
      const recallEvent = taskEvents.find((event) => eventName(event.event) === "memoryrecalled");
      const recallPayload = recordValue(recallEvent?.payload);
      const recalledBlocks = Array.isArray(recallPayload?.memories)
        ? recallPayload.memories.filter((memory): memory is string => typeof memory === "string")
        : undefined;
      const primerIds = Array.isArray(recallPayload?.primers)
        ? recallPayload.primers.filter((primer): primer is string => typeof primer === "string")
        : undefined;
      return {
        nodeId,
        ...task,
        status: node.status,
        config: configFromNode(node),
        recallQuery: typeof recallPayload?.query === "string" ? recallPayload.query : undefined,
        recalledBlocks,
        primerIds,
        recallTokenCost: typeof recallPayload?.tokenCost === "number" ? recallPayload.tokenCost : undefined,
        toolCalls: toolNamesFromNode(node),
        digest: digestForTask(facts, runId, nodeId),
      };
    })
    .filter((row) => row !== undefined);
}

function ConfigTable({ config }: { config?: MemoryConfig }) {
  if (!config) {
    return (
      <EmptyState
        title="Resolved config not exposed"
        description="The gateway run-tree contract does not currently carry TaskDescriptor.memoryConfig."
      />
    );
  }
  return (
    <Table>
      <TableBody>
        <TableRow>
          <TableCell>bank</TableCell>
          <TableCell>{config.bank ?? config.banks?.join(", ") ?? "none"}</TableCell>
        </TableRow>
        <TableRow>
          <TableCell>tags</TableCell>
          <TableCell>{config.tags?.join(", ") ?? "none"}</TableCell>
        </TableRow>
        <TableRow>
          <TableCell>recall</TableCell>
          <TableCell>{config.recall === false ? "false" : (config.recall ?? "default")}</TableCell>
        </TableRow>
        <TableRow>
          <TableCell>budget / cap</TableCell>
          <TableCell>
            {config.budget ?? "default"} / {config.maxTokens ?? "default"} tokens
          </TableCell>
        </TableRow>
        <TableRow>
          <TableCell>primers</TableCell>
          <TableCell>{config.primers?.join(", ") ?? "none"}</TableCell>
        </TableRow>
        <TableRow>
          <TableCell>retain</TableCell>
          <TableCell>{config.retain ?? "default"}</TableCell>
        </TableRow>
        <TableRow>
          <TableCell>tools</TableCell>
          <TableCell>{config.tools ? "remember + recall" : "disabled"}</TableCell>
        </TableRow>
      </TableBody>
    </Table>
  );
}

function RecallPanel({ row }: { row: LifecycleRow }) {
  if (row.config?.recall === false) {
    return <p>Pre-task recall is disabled for this task.</p>;
  }
  if (!row.recallQuery && !row.recalledBlocks?.length && !row.primerIds?.length) {
    return (
      <p>
        No attributable recall snapshot is exposed by the gateway. Declarative memory injection is not currently emitted
        as a per-task event.
      </p>
    );
  }
  return (
    <>
      {row.recallQuery ? <p>Query: {row.recallQuery}</p> : null}
      {row.primerIds?.length ? <p>Primers: {row.primerIds.join(", ")}</p> : null}
      {row.recalledBlocks?.length ? <Markdown content={row.recalledBlocks.join("\n\n")} /> : null}
      <p>Token cost: {row.recallTokenCost ?? "not exposed"}</p>
    </>
  );
}

export function LifecycleCard({ row }: { row: LifecycleRow }) {
  const stages = [
    {
      label: "Recall",
      status: row.config?.recall === false || row.recallQuery ? "done" : "pending",
    },
    {
      label: "Task",
      status: row.status,
    },
    {
      label: "Retain",
      status: row.config?.retain === "off" || row.digest ? "done" : "pending",
    },
  ];
  return (
    <Card>
      <div>
        <h2>{row.label}</h2>
        <p>
          {row.nodeId} · {row.mode}
        </p>
      </div>
      <StatusPill status={row.status} />
      <StageStrip stages={stages} showSummary />
      <div>
        <Badge>RECALL</Badge>
        <RecallPanel row={row} />
      </div>
      <div>
        <Badge>TASK TOOLS</Badge>
        <p>
          {row.toolCalls.length > 0
            ? row.toolCalls.join(", ")
            : "No remember or recall calls observed in gateway data."}
        </p>
      </div>
      <div>
        <Badge>RETAIN</Badge>
        {row.digest ? (
          <Markdown content={row.digest} />
        ) : (
          <p>
            {row.config?.retain === "off"
              ? "Automatic retention is disabled."
              : "No task-scoped digest is visible yet."}
          </p>
        )}
      </div>
      <CollapsiblePanel
        title="Resolved memory configuration"
        meta={row.config ? "from gateway metadata" : "not exposed by gateway"}
      >
        <ConfigTable config={row.config} />
      </CollapsiblePanel>
    </Card>
  );
}

export function MemoryLifecycle({ rows }: { rows: ReadonlyArray<LifecycleRow> }) {
  if (rows.length === 0) {
    return (
      <EmptyState title="No memory tasks yet" description="Start a memory-recall-demo run to populate the lifecycle." />
    );
  }
  return (
    <>
      {rows.map((row) => (
        <LifecycleCard key={row.nodeId} row={row} />
      ))}
    </>
  );
}

export function MemoryRecallApp({ runId = runIdFromUrl() }: { runId?: string } = {}) {
  const run = useGatewayRun(runId);
  const tree = useGatewayRunTree(runId);
  const stream = useGatewayRunEvents(runId, { maxEvents: 1000 });
  const facts = useGatewayMemoryFacts("workflow:support-triage-demo");
  const refetchFacts = facts.refetch;
  const status =
    typeof run.data === "object" && run.data !== null && "status" in run.data ? String(run.data.status) : undefined;

  useEffect(() => {
    if (status === "finished" || status === "completed" || status === "failed") {
      void refetchFacts();
    }
  }, [refetchFacts, status]);

  const rows = useMemo(
    () => deriveMemoryLifecycle(tree.nodes, stream.events, facts.data ?? [], runId),
    [facts.data, runId, stream.events, tree.nodes],
  );

  return (
    <WorkflowUiShell
      title="Memory Recall"
      meta={`${runId ?? "preview"} · recall → task → retain${status ? ` · ${status}` : ""}`}
    >
      <SmithersUiStyles />
      <Card>
        <h2>Memory lifecycle</h2>
        <p>
          Each card is derived from the gateway run tree, event stream, or local facts collection. Unavailable fields
          are labeled instead of invented.
        </p>
        <MemoryLifecycle rows={rows} />
      </Card>
      <Card>
        <h2>Run tree</h2>
        <RunTree runId={runId} />
      </Card>
      <Card>
        <h2>Gateway events</h2>
        <RunEventLog runId={runId} style={{ height: 320 }} />
      </Card>
    </WorkflowUiShell>
  );
}

if (typeof document !== "undefined") {
  createGatewayReactRoot(<MemoryRecallApp />);
}
