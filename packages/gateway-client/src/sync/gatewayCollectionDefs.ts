import type { Collection } from "@tanstack/db";
import type { ListApprovalsRequest, ListDocsRequest, ListRunsRequest, ListWorkflowsRequest } from "@smithers-orchestrator/gateway/rpc";
import type { GatewayApprovalRow } from "./GatewayApprovalRow.ts";
import type { GatewayDocRow } from "./GatewayDocRow.ts";
import type { GatewayRunEventRow } from "./GatewayRunEventRow.ts";
import type { GatewayRunNode } from "./GatewayRunNode.ts";
import type { GatewayRunRow } from "./GatewayRunRow.ts";
import type { GatewayRunSummaryRow } from "./GatewayRunSummaryRow.ts";
import type { GatewayWorkflowRow } from "./GatewayWorkflowRow.ts";
import type { CollectionDef } from "./CollectionDef.ts";
import { flattenGatewayRunNode } from "./flattenGatewayRunNode.ts";
import { snapshotToGatewayRunNode, type DevToolsSnapshot } from "./snapshotToGatewayRunNode.ts";
import { sanitizeRunEventRowForPersistence } from "./sanitizeRunEventRowForPersistence.ts";
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

function eventRows(frame: { key: readonly unknown[]; seq?: number; event: string; payload: unknown }): GatewayRunEventRow[] {
  if (typeof frame.seq !== "number") return [];
  return [{
    key: frame.key as GatewayRunEventRow["key"],
    seq: frame.seq,
    event: frame.event,
    payload: frame.payload,
  }];
}

function runStatusFromFrame(frame: { payload: unknown }): string | undefined {
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

function runRowsFromFrame(runId: string) {
  return (frame: { payload: unknown }, { collection }: { collection: Collection<GatewayRunRow, string> }) => {
    const status = runStatusFromFrame(frame);
    const current = collection.get(runId);
    if (!status || !current) return [];
    return [{ ...withoutVirtualFields(current), status }];
  };
}

export const gatewayCollectionDefs = {
  tickets: (params: ListDocsRequest = {}): CollectionDef<GatewayDocRow, string> => {
    const effectiveParams = {
      ...params,
      filter: {
        ...params.filter,
        includeDeleted: params.filter?.includeDeleted ?? true,
      },
    };
    return {
      key: gatewayKeys.tickets(effectiveParams),
      persisted: true,
      maxRows: 4_096,
      getKey: (row: GatewayDocRow) => row.path,
      gateway: {
        method: "listDocs",
        params: effectiveParams,
        rows: arrayRows<GatewayDocRow>,
        pollMs: 1_000,
      },
      electric: {
        shape: { table: "_smithers_docs" },
      },
    };
  },
  workflows: (params: ListWorkflowsRequest = {}): CollectionDef<GatewayWorkflowRow, string> => ({
    key: gatewayKeys.workflows(params.filter),
    persisted: true,
    getKey: (row: GatewayWorkflowRow) => row.key,
    gateway: {
      method: "listWorkflows",
      params,
      rows: arrayRows<GatewayWorkflowRow>,
    },
  }),
  runs: (params: ListRunsRequest = {}): CollectionDef<GatewayRunSummaryRow, string> => ({
    key: gatewayKeys.runs(params),
    persisted: true,
    getKey: (row: GatewayRunSummaryRow) => row.runId,
    gateway: {
      method: "listRuns",
      params,
      rows: arrayRows<GatewayRunSummaryRow>,
    },
    electric: {
      shape: { table: "_smithers_runs" },
    },
  }),
  run: (runId: string): CollectionDef<GatewayRunRow, string> => ({
    key: gatewayKeys.run(runId),
    persisted: true,
    getKey: (row: GatewayRunRow) => row.runId,
    gateway: {
      method: "getRun",
      params: { runId },
      rows: singleRow<GatewayRunRow>,
      stream: {
        scope: "streamRunEvents",
        params: { runId },
        frameToRows: runRowsFromFrame(runId),
      },
    },
    electric: {
      shape: { table: "_smithers_runs", where: `run_id = '${runId.replaceAll("'", "''")}'` },
    },
  }),
  nodes: (
    runId: string,
    rows: (payload: unknown) => Iterable<GatewayRunNode> = snapshotRows,
  ): CollectionDef<GatewayRunNode, string> => ({
    key: gatewayKeys.devtoolsSnapshot(runId),
    persisted: true,
    getKey: (row: GatewayRunNode) => row.id,
    gateway: {
      method: "getDevToolsSnapshot",
      params: { runId },
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
    },
    electric: {
      shape: { table: "_smithers_nodes", where: `run_id = '${runId.replaceAll("'", "''")}'` },
    },
  }),
  approvals: (params: ListApprovalsRequest = {}): CollectionDef<GatewayApprovalRow, string> => ({
    key: gatewayKeys.approvals(params),
    persisted: true,
    getKey: (row: GatewayApprovalRow) => `${row.runId}:${row.nodeId}:${row.iteration}`,
    gateway: {
      method: "listApprovals",
      params,
      rows: arrayRows<GatewayApprovalRow>,
    },
    electric: {
      shape: { table: "_smithers_approvals" },
    },
  }),
  runEvents: (runId: string, maxRows = 1_024): CollectionDef<GatewayRunEventRow, number> => ({
    key: gatewayKeys.runEvents(runId),
    persisted: true,
    maxRows,
    // The live ring keeps full frames; the durable copy drops blob-bearing
    // payloads (node outputs, transcripts, traces) so large rows never land in
    // client persistence — they stay RPC-on-demand by id (design §5.4).
    sanitizeForPersistence: sanitizeRunEventRowForPersistence,
    getKey: (row: GatewayRunEventRow) => row.seq,
    gateway: {
      stream: {
        scope: "streamRunEvents",
        params: { runId },
        frameToRows: eventRows,
        maxRows,
      },
    },
    electric: {
      shape: { table: "_smithers_events", where: `run_id = '${runId.replaceAll("'", "''")}'` },
    },
  }),
} as const;
