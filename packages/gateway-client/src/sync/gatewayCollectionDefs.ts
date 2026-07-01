import { withoutVirtualFields } from "./withoutVirtualFields.ts";
import type { Collection } from "@tanstack/db";
import { asRecord } from "../objectGuards.ts";
import type { CronListRequest, ListApprovalsRequest, ListMemoryFactsRequest, ListPromptsRequest, ListRunsRequest, ListScoresRequest, ListTicketsRequest, ListWorkflowsRequest } from "@smithers-orchestrator/gateway/rpc";
import type { GatewayApprovalRow } from "./GatewayApprovalRow.ts";
import type { GatewayCronRow } from "./GatewayCronRow.ts";
import type { GatewayMemoryFactRow } from "./GatewayMemoryFactRow.ts";
import type { GatewayPromptRow } from "./GatewayPromptRow.ts";
import type { GatewayScoreRow } from "./GatewayScoreRow.ts";
import type { GatewayTicketRow } from "./GatewayTicketRow.ts";
import type { GatewayRunEventRow } from "./GatewayRunEventRow.ts";
import { runNodeKey, type GatewayRunNode } from "./GatewayRunNode.ts";
import type { GatewayRunRow } from "./GatewayRunRow.ts";
import type { GatewayRunSummaryRow } from "./GatewayRunSummaryRow.ts";
import type { GatewayWorkflowRow } from "./GatewayWorkflowRow.ts";
import { flattenGatewayRunNode } from "./flattenGatewayRunNode.ts";
import { snapshotToGatewayRunNode, type DevToolsSnapshot } from "./snapshotToGatewayRunNode.ts";
import { gatewayKeys } from "./gatewayKeys.ts";

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

/**
 * Reserved row key for the single latest `run.heartbeat`. Heartbeat frames carry
 * a CONNECTION seq (not a per-run event seq — see `SyncTransport`), so keying
 * them by `seq` like real events (a) mixes two sequence domains in one collection
 * and (b) lets every heartbeat land as its OWN row, consuming the bounded
 * `runEvents` ring and evicting real events (defeating callers that asked for
 * `maxEvents` history). Instead every heartbeat maps to THIS one reserved key, so
 * they collapse to a single latest-heartbeat row in a separate keyspace: it never
 * accumulates, and — being the maximum possible numeric key — it always sorts to
 * the end of the ring's eviction order, so it is never among the evicted low keys
 * and can never push a real event out. `Number.MAX_SAFE_INTEGER` is safely above
 * any real per-run event seq, so the keyspaces never collide.
 */
export const RUN_HEARTBEAT_ROW_KEY = Number.MAX_SAFE_INTEGER;

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
    // Preserve `cancelled` as its own terminal status: a user-cancelled run is
    // not a failure, and collapsing it to `failed` would make every consumer
    // (TUI header, gateway-react, web) mislabel a deliberate cancel as an error.
    if (state === "failed") return "failed";
    if (state === "cancelled") return "cancelled";
    return state ?? "ok";
  }
  if (innerEvent === "run.started" || innerEvent === "run.resumed") return "running";
  if (innerEvent === "run.paused") return "waiting";
  return undefined;
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
    // Key by the unique row `key` (not the logical `id`): loop/retry attempts
    // share an `id`, so id-keying would silently drop every attempt but the
    // first. `runNodeKey` falls back to `id` for rows without a `key`.
    getKey: (row: GatewayRunNode) => runNodeKey(row),
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
  crons: (params: CronListRequest = {}) => ({
    key: gatewayKeys.cronList(params),
    method: "cronList",
    params,
    getKey: (row: GatewayCronRow) => row.cronId,
    rows: arrayRows<GatewayCronRow>,
  }),
  memoryFacts: (params: ListMemoryFactsRequest = {}) => ({
    key: gatewayKeys.memoryFacts(params),
    method: "listMemoryFacts",
    params,
    // `_smithers_memory_facts` is keyed by `(namespace, key)` and an unfiltered
    // `listMemoryFacts` returns every namespace, so `key` alone is NOT unique:
    // two namespaces can share a key and would collide (one row silently drops)
    // in TanStack DB. Key by the real composite PK.
    getKey: (row: GatewayMemoryFactRow) => `${row.namespace}:${row.key}`,
    rows: arrayRows<GatewayMemoryFactRow>,
  }),
  prompts: (params: ListPromptsRequest = {}) => ({
    key: gatewayKeys.prompts(params),
    method: "listPrompts",
    params,
    // Key by `entryFile` — the workspace-relative source path WITH extension
    // (e.g. `prompts/refactor.mdx`), which is unique per file. `id` is the
    // relative path WITHOUT the extension, so `foo.md` and `foo.mdx` both map to
    // id `foo`; keying by `id` would collide and TanStack DB would silently drop
    // one valid prompt. `entryFile` is 1:1 with a real file, so both survive.
    getKey: (row: GatewayPromptRow) => row.entryFile,
    rows: arrayRows<GatewayPromptRow>,
  }),
  scores: (params: ListScoresRequest = { runId: "" }) => ({
    key: gatewayKeys.scores(params),
    method: "listScores",
    params,
    // One run can carry many score rows: the same scorer fires across nodes,
    // iterations, and attempts. `(runId, nodeId, iteration, scorerId)` is the
    // run-level identity used by the surface (it collapses repeated attempts of
    // the same scorer-at-node-iteration), so key by that composite — `scorerId`
    // alone (or even `nodeId:scorerId`) would collide across iterations.
    getKey: (row: GatewayScoreRow) =>
      `${row.runId}:${row.nodeId}:${row.iteration}:${row.scorerId}`,
    rows: arrayRows<GatewayScoreRow>,
  }),
  tickets: (params: ListTicketsRequest = {}) => ({
    key: gatewayKeys.tickets(params),
    method: "listTickets",
    params,
    // `_smithers_docs` is keyed by `path` (the doc identity / id), which is the
    // natural primary key the surface selects/edits by. `listTickets` already
    // filters tombstones server-side, so every row here is live.
    getKey: (row: GatewayTicketRow) => row.path,
    rows: arrayRows<GatewayTicketRow>,
  }),
  runEvents: (runId: string, maxRows = 1_024) => ({
    // Thread the effective cap into the key so different caps resolve to
    // different collections (each sized to its own `maxRows` ring below).
    key: gatewayKeys.runEvents(runId, maxRows),
    // Real run events key by their per-run `seq`; every `run.heartbeat` collapses
    // to the reserved `RUN_HEARTBEAT_ROW_KEY` so heartbeats occupy a single,
    // non-evicting slot instead of flooding the ring and evicting real events
    // (and so the connection-seq heartbeat domain never collides with event seqs).
    getKey: (row: GatewayRunEventRow) =>
      row.event === "run.heartbeat" ? RUN_HEARTBEAT_ROW_KEY : row.seq,
    stream: {
      scope: "streamRunEvents",
      params: { runId },
      frameToRows: eventRows,
      // Size the ring to `maxRows` REAL events plus one reserved slot for the
      // pinned `RUN_HEARTBEAT_ROW_KEY` heartbeat row, so a caller asking for
      // `maxRows` events always retains that many real events even while the
      // latest heartbeat is present (the heartbeat never steals an event slot).
      maxRows: maxRows + 1,
    },
  }),
} as const;
