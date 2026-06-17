import type { Txid } from "@tanstack/electric-db-collection";
import type { CollectionConfig } from "@tanstack/db";
import type { CollectionDef } from "./CollectionDef.ts";
import type { SyncKey } from "./SyncKey.ts";
import { syncKeyFingerprint } from "./SyncKey.ts";

type ElectricWriteOperation = "insert" | "update" | "delete";
type MatchingStrategy = { txid: Txid | Txid[]; timeout?: number } | void;

export type ElectricWriteRequest = {
  collectionId: string;
  table: string;
  operation: ElectricWriteOperation;
  mutations: readonly unknown[];
};

export type ElectricWriteCommit = (request: ElectricWriteRequest) => Promise<{ txid?: Txid | null } | void>;

export type CreateElectricCollectionOptions<TRow extends object, TKey extends string | number> = {
  key: SyncKey;
  def: CollectionDef<TRow, TKey>;
  proxyUrl: string;
  getKey: (row: TRow) => TKey;
  headers?: Record<string, string | (() => string | Promise<string>)>;
  fetchClient?: typeof fetch;
  write?: ElectricWriteCommit;
  txidTimeoutMs?: number;
  onAwaitTxIdReady?: (awaitTxId: (txid: Txid, timeout?: number) => Promise<boolean>) => void;
  onError?: (error: Error) => void;
  onReady?: () => void;
};

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function camelKey(key: string): string {
  return key.replace(/_([a-z0-9])/g, (_, ch: string) => ch.toUpperCase());
}

function camelize(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) out[camelKey(key)] = value;
  return out;
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string" || value.length === 0) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function runWorkflowKey(row: Record<string, unknown>): string | undefined {
  const config = asRecord(parseJson(row.configJson));
  return asString(config.gatewayWorkflowKey) ?? asString(row.workflowName);
}

function defaultElectricRow<TRow extends object>(
  def: CollectionDef<TRow, string | number>,
  row: Record<string, unknown>,
): TRow {
  const camel = camelize(row);
  const table = def.electric?.shape.table;
  if (table === "_smithers_runs") {
    return {
      ...camel,
      runId: asString(camel.runId) ?? asString(row.run_id) ?? "",
      workflowKey: runWorkflowKey(camel),
    } as TRow;
  }
  if (table === "_smithers_events") {
    const runId = asString(camel.runId) ?? asString(row.run_id) ?? "";
    const seq = asNumber(camel.seq) ?? Number(row.seq);
    return {
      key: ["gateway:runEvents", runId],
      runId,
      seq,
      event: asString(camel.type) ?? asString(row.type) ?? "event",
      payload: parseJson(camel.payloadJson ?? row.payload_json) ?? {},
    } as TRow;
  }
  if (table === "_smithers_nodes") {
    const runId = asString(camel.runId) ?? asString(row.run_id) ?? "";
    const nodeId = asString(camel.nodeId) ?? asString(row.node_id) ?? "";
    const iteration = asNumber(camel.iteration) ?? Number(row.iteration ?? 0);
    return {
      ...camel,
      id: `${runId}:${nodeId}:${iteration}`,
      name: asString(camel.label) ?? nodeId,
      kind: "task",
      status: asString(camel.state) ?? "unknown",
    } as TRow;
  }
  if (table === "_smithers_approvals") {
    const request = asRecord(parseJson(camel.requestJson ?? row.request_json));
    const decision = parseJson(camel.decisionJson ?? row.decision_json);
    return {
      ...camel,
      runId: asString(camel.runId) ?? asString(row.run_id) ?? "",
      nodeId: asString(camel.nodeId) ?? asString(row.node_id) ?? "",
      iteration: asNumber(camel.iteration) ?? Number(row.iteration ?? 0),
      requestTitle: asString(request.title) ?? asString(camel.nodeId) ?? asString(row.node_id),
      requestSummary: asString(request.summary),
      approvalMode: asString(request.mode),
      options: request.options,
      allowedScopes: Array.isArray(request.allowedScopes) ? request.allowedScopes : [],
      allowedUsers: Array.isArray(request.allowedUsers) ? request.allowedUsers : [],
      autoApprove: request.autoApprove,
      decision,
    } as TRow;
  }
  if (table === "_smithers_docs") {
    return {
      ...camel,
      path: asString(camel.path) ?? "",
      contentHash: asString(camel.contentHash) ?? asString(row.content_hash) ?? "",
    } as TRow;
  }
  return camel as TRow;
}

function strategyFromResult(result: { txid?: Txid | null } | void, timeout?: number): MatchingStrategy {
  if (!result || result.txid === undefined || result.txid === null) return undefined;
  return { txid: result.txid, ...(timeout === undefined ? {} : { timeout }) };
}

export function createElectricCollection<TRow extends object, TKey extends string | number = string>(
  options: CreateElectricCollectionOptions<TRow, TKey>,
): CollectionConfig<TRow, TKey> {
  const shape = options.def.electric?.shape;
  if (!shape) {
    throw new Error(`Electric collection requires an electric shape: ${syncKeyFingerprint(options.key)}`);
  }
  const id = syncKeyFingerprint(options.key);
  const transform = options.def.electric?.rows ?? ((row: Record<string, unknown>) => defaultElectricRow(options.def as unknown as CollectionDef<TRow, string | number>, row) as TRow);
  const write = options.write;
  const onInsert: CollectionConfig<Record<string, unknown>, string | number>["onInsert"] = write
      ? async (params) => strategyFromResult(
          await write({
            collectionId: id,
            table: shape.table,
            operation: "insert",
            mutations: params.transaction.mutations,
          }),
          options.txidTimeoutMs,
        )
      : undefined;
  const onUpdate: CollectionConfig<Record<string, unknown>, string | number>["onUpdate"] = write
      ? async (params) => strategyFromResult(
          await write({
            collectionId: id,
            table: shape.table,
            operation: "update",
            mutations: params.transaction.mutations,
          }),
          options.txidTimeoutMs,
        )
      : undefined;
  const onDelete: CollectionConfig<Record<string, unknown>, string | number>["onDelete"] = write
      ? async (params) => strategyFromResult(
          await write({
            collectionId: id,
            table: shape.table,
            operation: "delete",
            mutations: params.transaction.mutations,
          }),
          options.txidTimeoutMs,
        )
      : undefined;
  return {
    id,
    getKey: options.getKey,
    ...(onInsert ? { onInsert: onInsert as CollectionConfig<TRow, TKey>["onInsert"] } : {}),
    ...(onUpdate ? { onUpdate: onUpdate as CollectionConfig<TRow, TKey>["onUpdate"] } : {}),
    ...(onDelete ? { onDelete: onDelete as CollectionConfig<TRow, TKey>["onDelete"] } : {}),
    sync: {
      sync(api) {
        let cleanup: unknown;
        let disposed = false;
        void import("@tanstack/electric-db-collection").then(({ electricCollectionOptions }) => {
          if (disposed) return;
          const base = electricCollectionOptions<Record<string, unknown>>({
            id,
            getKey: (row) => options.getKey(row as TRow),
            shapeOptions: {
              url: options.proxyUrl,
              liveSse: true,
              subscribe: true,
              log: "full",
              ...(options.fetchClient ? { fetchClient: options.fetchClient } : {}),
              ...(options.headers ? { headers: options.headers } : {}),
              params: {
                table: shape.table,
                replica: "full",
                ...(shape.where ? { where: shape.where } : {}),
                ...(shape.columns ? { columns: shape.columns as string[] } : {}),
              },
              transformer: (row) => transform(row as Record<string, unknown>) as Record<string, unknown>,
            },
            onInsert,
            onUpdate,
            onDelete,
          });
          options.onAwaitTxIdReady?.(base.utils.awaitTxId);
          cleanup = base.sync.sync({
            ...api,
            markReady: () => {
              options.onReady?.();
              api.markReady();
            },
          } as never);
          if (disposed && typeof cleanup === "function") cleanup();
        }).catch((cause) => {
          const error = cause instanceof Error ? cause : new Error(String(cause));
          options.onError?.(error);
        });
        return () => {
          disposed = true;
          if (typeof cleanup === "function") cleanup();
        };
      },
    } as CollectionConfig<TRow, TKey>["sync"],
  };
}
