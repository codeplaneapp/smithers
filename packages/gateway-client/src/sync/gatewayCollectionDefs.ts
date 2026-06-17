import type { Collection } from "@tanstack/db";
import type { ListApprovalsRequest, ListRunsRequest, ListWorkflowsRequest } from "@smithers-orchestrator/gateway/rpc";
import type { GatewayApprovalRow } from "./GatewayApprovalRow.ts";
import type { GatewayRunEventRow } from "./GatewayRunEventRow.ts";
import type { GatewayRunNode } from "./GatewayRunNode.ts";
import type { GatewayRunRow } from "./GatewayRunRow.ts";
import type { GatewayRunSummaryRow } from "./GatewayRunSummaryRow.ts";
import type { GatewayWorkflowRow } from "./GatewayWorkflowRow.ts";
import { flattenGatewayRunNode } from "./flattenGatewayRunNode.ts";
import { snapshotToGatewayRunNode, type DevToolsSnapshot } from "./snapshotToGatewayRunNode.ts";
import { gatewayKeys } from "./gatewayKeys.ts";

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function arrayRows<TRow>(payload: unknown): TRow[] {
  return Array.isArray(payload) ? payload as TRow[] : [];
}

function singleRow<TRow>(payload: unknown): TRow[] {
  return typeof payload === "object" && payload !== null && !Array.isArray(payload)
    ? [payload as TRow]
    : [];
}

/**
 * Map a real `getDevToolsSnapshot` payload (`{ root: SnapshotNode }`, a tree)
 * into the flat `GatewayRunNode` rows the `nodes` collection stores. `arrayRows`
 * cannot do this — the RPC returns an object, not an array — so the run tree has
 * to be walked and flattened.
 */
function snapshotRows(payload: unknown): GatewayRunNode[] {
  return flattenGatewayRunNode(
    snapshotToGatewayRunNode(payload as DevToolsSnapshot | null | undefined),
  );
}

export function eventRows(frame: { key: readonly unknown[]; seq?: number; event: string; payload: unknown }): GatewayRunEventRow[] {
  if (typeof frame.seq !== "number") return [];
  return [{
    key: frame.key as GatewayRunEventRow["key"],
    seq: frame.seq,
    event: frame.event,
    payload: frame.payload,
  }];
}

export function runStatusFromFrame(frame: { payload: unknown }): string | undefined {
  const payload = asRecord(frame.payload);
  const innerEvent = asString(payload.event);
  if (!innerEvent) return undefined;
  const innerPayload = asRecord(payload.payload);
  if (innerEvent === "run.completed") {
    const state = asString(innerPayload.state) ?? asString(innerPayload.status);
    if (state === "failed" || state === "cancelled") return "failed";
    return state ?? "ok";
  }
  if (innerEvent === "run.started" || innerEvent === "run.resumed") return "running";
  if (innerEvent === "run.paused") return "waiting";
  return undefined;
}

function withoutVirtualFields<TRow extends Record<string, unknown>>(row: TRow): TRow {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (!key.startsWith("$") && value !== undefined) {
      out[key] = value;
    }
  }
  return out as TRow;
}

export function runRowsFromFrame(runId: string) {
  return (frame: { payload: unknown }, { collection }: { collection: Collection<GatewayRunRow, string> }) => {
    const status = runStatusFromFrame(frame);
    const current = collection.get(runId);
    if (!status || !current) return [];
    return [{ ...withoutVirtualFields(current), status }];
  };
}

export const gatewayCollectionDefs = {
  workflows: (params: ListWorkflowsRequest = {}) => ({
    key: gatewayKeys.workflows(params.filter),
    method: "listWorkflows",
    params,
    getKey: (row: GatewayWorkflowRow) => row.key,
    rows: arrayRows<GatewayWorkflowRow>,
  }),
  runs: (params: ListRunsRequest = {}) => ({
    key: gatewayKeys.runs(params),
    method: "listRuns",
    params,
    getKey: (row: GatewayRunSummaryRow) => row.runId,
    rows: arrayRows<GatewayRunSummaryRow>,
  }),
  run: (runId: string) => ({
    key: gatewayKeys.run(runId),
    method: "getRun",
    params: { runId },
    getKey: (row: GatewayRunRow) => row.runId,
    rows: singleRow<GatewayRunRow>,
    stream: {
      scope: "streamRunEvents",
      params: { runId },
      frameToRows: runRowsFromFrame(runId),
    },
  }),
  nodes: (runId: string, rows: (payload: unknown) => Iterable<GatewayRunNode> = snapshotRows) => ({
    key: gatewayKeys.devtoolsSnapshot(runId),
    method: "getDevToolsSnapshot",
    params: { runId },
    getKey: (row: GatewayRunNode) => row.id,
    rows,
    // DevTools frames carry deltas, not full trees, so the honest mapping into a
    // node-keyed collection is to re-pull `getDevToolsSnapshot` and reconcile.
    // `refetchMode: "replace"` diffs against the live collection (via
    // `createGatewayCollection`'s `replaceRows`) and writes only the rows that
    // actually changed, so reactive consumers see fine-grained updates rather
    // than a full-tree churn. Consumers that maintain their own tree can apply
    // frames incrementally with the exported `reconcileSnapshotNodes` instead.
    stream: {
      scope: "streamDevTools",
      params: { runId },
      refetchOnFrame: true,
      refetchMode: "replace" as const,
      reconnectOnGracefulEnd: true,
    },
  }),
  approvals: (params: ListApprovalsRequest = {}) => ({
    key: gatewayKeys.approvals(params),
    method: "listApprovals",
    params,
    getKey: (row: GatewayApprovalRow) => `${row.runId}:${row.nodeId}:${row.iteration}`,
    rows: arrayRows<GatewayApprovalRow>,
  }),
  runEvents: (runId: string, maxRows = 1_024) => ({
    key: gatewayKeys.runEvents(runId),
    getKey: (row: GatewayRunEventRow) => row.seq,
    stream: {
      scope: "streamRunEvents",
      params: { runId },
      frameToRows: eventRows,
      maxRows,
    },
  }),
} as const;
