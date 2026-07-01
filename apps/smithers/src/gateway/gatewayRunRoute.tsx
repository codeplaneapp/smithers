import { createRoute } from "@tanstack/react-router";
import { useGatewayRun, useGatewayRunEvents, useGatewayRpc } from "@smithers-orchestrator/gateway-react";
import { rootRoute } from "../app/rootRoute";
import { TimelineCanvas } from "../timeline/TimelineCanvas";
import { TicketsCanvas } from "../tickets/TicketsCanvas";
import { GatewayRunInspector } from "./GatewayRunInspector";

/**
 * Gateway-backed run detail routes. `/gw/$workflowKey/$runId` is the canonical
 * run inspector; subroutes hang off the same run identity so links opened from
 * live gateway rows never fall back to the old local `runsStore` fixtures.
 */
function GatewayRunPage() {
  const { workflowKey, runId } = gatewayRunRoute.useParams();
  return <GatewayRunInspector workflowKey={workflowKey} runId={runId} />;
}

export const gatewayRunRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/gw/$workflowKey/$runId",
  component: GatewayRunPage,
});

function GatewayRunLogsPage() {
  const { workflowKey, runId } = gatewayRunLogsRoute.useParams();
  return <GatewayRunLogsCanvas workflowKey={workflowKey} runId={runId} />;
}

function formatEventPayload(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function GatewayRunLogsCanvas({
  workflowKey,
  runId,
}: {
  workflowKey: string;
  runId: string;
}) {
  const run = useGatewayRun(runId);
  const stream = useGatewayRunEvents(runId, { maxEvents: 200 });
  const status = typeof run.data?.status === "string" ? run.data.status : "unknown";

  return (
    <section className="surface" data-testid="logs-canvas">
      <header className="surface-head logs-toolbar">
        <span className="surface-title">Run logs</span>
        <span className="surface-sub">
          {workflowKey} · {runId} · {status}
        </span>
        <span className="logs-search">
          {stream.streaming ? "streaming" : stream.error ? "stream interrupted" : "event replay"}
        </span>
      </header>
      {stream.error ? (
        <div className="surface-empty" role="alert">
          {stream.error.message}
        </div>
      ) : stream.events.length === 0 ? (
        <div className="surface-empty">No run events received yet.</div>
      ) : (
        <div className="logs-stream">
          {stream.events.map((event) => (
            <div className="log-line role-agent" key={`${event.seq}-${event.event}`}>
              <span className="log-role">#{event.seq} {event.event} ›</span>{" "}
              {formatEventPayload(event.payload)}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

export const gatewayRunLogsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/gw/$workflowKey/$runId/logs",
  component: GatewayRunLogsPage,
});

function parseDiffId(diffId: string): { nodeId: string; iteration: number } {
  const match = diffId.match(/^(.+?)(?:[@:](\d+))?$/);
  return {
    nodeId: match?.[1] && match[1].trim() ? match[1] : diffId,
    iteration: match?.[2] ? Number(match[2]) : 0,
  };
}

function GatewayRunDiffPage() {
  const { workflowKey, runId, diffId } = gatewayRunDiffRoute.useParams();
  const { nodeId, iteration } = parseDiffId(diffId);
  const diff = useGatewayRpc(
    "getNodeDiff",
    { runId, nodeId, iteration },
    { deps: [runId, nodeId, iteration] },
  );

  return (
    <section className="surface" data-testid="diff-canvas">
      <header className="surface-head">
        <span className="surface-title">Node diff</span>
        <span className="surface-sub">
          {workflowKey} · {runId} · {nodeId}:{iteration}
        </span>
      </header>
      {diff.isLoading ? (
        <div className="surface-empty">Loading diff from gateway...</div>
      ) : diff.error ? (
        <div className="surface-empty" role="alert">
          {diff.error.message}
        </div>
      ) : (
        <pre className="gw-node-output" data-testid="gateway-node-diff">
          {formatEventPayload(diff.data)}
        </pre>
      )}
    </section>
  );
}

export const gatewayRunDiffRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/gw/$workflowKey/$runId/diff/$diffId",
  component: GatewayRunDiffPage,
});

function GatewayRunTimelinePage() {
  const { runId } = gatewayRunTimelineRoute.useParams();
  return <TimelineCanvas runId={runId} />;
}

export const gatewayRunTimelineRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/gw/$workflowKey/$runId/timeline",
  component: GatewayRunTimelinePage,
});

function GatewayRunTicketsPage() {
  return <TicketsCanvas />;
}

export const gatewayRunTicketsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/gw/$workflowKey/$runId/tickets",
  component: GatewayRunTicketsPage,
});
