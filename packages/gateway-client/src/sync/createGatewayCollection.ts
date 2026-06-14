import { deepEquals, type Collection, type CollectionConfig } from "@tanstack/db";
import type { SyncBackoffOptions } from "./SyncBackoff.ts";
import { syncBackoffDelay } from "./SyncBackoff.ts";
import type { SyncKey } from "./SyncKey.ts";
import { syncKeyFingerprint } from "./SyncKey.ts";
import type { SyncStreamFrame, SyncTransport } from "./SyncTransport.ts";

type GatewayCollectionWrite<TRow extends object, TKey extends string | number> =
  | { type: "insert" | "update" | "upsert"; value: TRow }
  | { type: "delete"; key: TKey };

type GatewayCollectionResolvedWrite<TRow extends object, TKey extends string | number> =
  | { type: "insert" | "update"; value: TRow }
  | { type: "delete"; key: TKey };

type GatewayCollectionSyncApi<TRow extends object, TKey extends string | number> = {
  collection: Collection<TRow, TKey>;
  signal: AbortSignal;
};

type GatewayCollectionStreamConfig<TRow extends object, TKey extends string | number> = {
  scope: string;
  params: unknown;
  afterSeq?: number;
  frameToRows?: (
    frame: SyncStreamFrame,
    api: GatewayCollectionSyncApi<TRow, TKey>,
  ) => Iterable<TRow> | Promise<Iterable<TRow>>;
  frameToWrites?: (
    frame: SyncStreamFrame,
    api: GatewayCollectionSyncApi<TRow, TKey>,
  ) => Iterable<GatewayCollectionWrite<TRow, TKey>> | Promise<Iterable<GatewayCollectionWrite<TRow, TKey>>>;
  refetchOnFrame?: boolean;
  refetchMode?: "replace" | "upsert";
  reconnectOnGracefulEnd?: boolean;
  maxRows?: number;
  backoff?: SyncBackoffOptions;
};

export type GatewayCollectionConfig<TRow extends object, TKey extends string | number = string> = {
  key: SyncKey;
  client: SyncTransport;
  getKey: (row: TRow) => TKey;
  method?: string;
  params?: unknown;
  rows?: (payload: unknown) => Iterable<TRow> | Promise<Iterable<TRow>>;
  stream?: GatewayCollectionStreamConfig<TRow, TKey>;
  gcTime?: number;
  startSync?: boolean;
  compare?: (left: TRow, right: TRow) => number;
  onAuthError?: (error: Error) => void;
  onError?: (error: Error) => void;
  onInsert?: CollectionConfig<TRow, TKey>["onInsert"];
  onUpdate?: CollectionConfig<TRow, TKey>["onUpdate"];
  onDelete?: CollectionConfig<TRow, TKey>["onDelete"];
};

function isAuthError(error: unknown): boolean {
  const record = error as { code?: unknown; status?: unknown } | undefined;
  const code = typeof record?.code === "string" ? record.code : "";
  const status = typeof record?.status === "number" ? record.status : undefined;
  const message = error instanceof Error ? error.message : String(error ?? "");
  return status === 401 ||
    status === 403 ||
    /^(UNAUTHORIZED|Unauthorized|FORBIDDEN|Forbidden)\b/.test(message) ||
    /^(Unauthorized|Forbidden)$/i.test(code);
}

function asError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}

function defaultRows<TRow extends object>(payload: unknown): TRow[] {
  if (Array.isArray(payload)) return payload as TRow[];
  if (typeof payload === "object" && payload !== null) return [payload as TRow];
  return [];
}

function toArray<TRow>(rows: Iterable<TRow>): TRow[] {
  return Array.isArray(rows) ? rows : Array.from(rows);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function withoutVirtualFields<TRow extends object>(row: TRow): TRow {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (!key.startsWith("$") && value !== undefined) {
      out[key] = value;
    }
  }
  return out as TRow;
}

function shouldWriteUpdate<TRow extends object, TKey extends string | number>(
  collection: Collection<TRow, TKey>,
  key: TKey,
  row: TRow,
): boolean {
  const current = collection.get(key);
  if (!current) return false;
  return !deepEquals(withoutVirtualFields(current), row);
}

function keySort(left: string | number, right: string | number): number {
  if (typeof left === "number" && typeof right === "number") return left - right;
  return String(left).localeCompare(String(right));
}

export function createGatewayCollection<TRow extends object, TKey extends string | number = string>(
  config: GatewayCollectionConfig<TRow, TKey>,
): CollectionConfig<TRow, TKey> {
  const rowsFromPayload = config.rows ?? defaultRows<TRow>;
  const id = syncKeyFingerprint(config.key);
  return {
    id,
    getKey: config.getKey,
    ...(config.gcTime === undefined ? {} : { gcTime: config.gcTime }),
    ...(config.startSync === undefined ? {} : { startSync: config.startSync }),
    ...(config.compare ? { compare: config.compare } : {}),
    ...(config.onInsert ? { onInsert: config.onInsert } : {}),
    ...(config.onUpdate ? { onUpdate: config.onUpdate } : {}),
    ...(config.onDelete ? { onDelete: config.onDelete } : {}),
    sync: {
      rowUpdateMode: "full",
      sync: ({ begin, write, commit, markReady, collection }) => {
        const controller = new AbortController();
        const signal = controller.signal;
        const stream = config.stream;
        const buffered: SyncStreamFrame[] = [];
        let initialComplete = false;
        let applyChain = Promise.resolve();

        const handleError = (cause: unknown) => {
          if (signal.aborted) return;
          const error = asError(cause);
          if (isAuthError(error)) {
            config.onAuthError?.(error);
          }
          config.onError?.(error);
        };

        const applyWrites = (writes: readonly GatewayCollectionWrite<TRow, TKey>[], maxRows?: number) => {
          if (writes.length === 0 && !maxRows) return;
          const deleted = new Set<TKey>();
          const liveKeys = new Set<TKey>(collection.keys());
          let normalized: Array<GatewayCollectionResolvedWrite<TRow, TKey>> = [];
          for (const item of writes) {
            if (item.type === "delete") {
              deleted.add(item.key);
              liveKeys.delete(item.key);
              if (collection.has(item.key)) {
                normalized.push(item);
              }
              continue;
            }
            const key = config.getKey(item.value);
            liveKeys.add(key);
            const type = item.type === "upsert"
              ? collection.has(key) ? "update" : "insert"
              : item.type;
            if (type === "update" && !shouldWriteUpdate(collection, key, item.value)) {
              continue;
            }
            if (type === "insert" && collection.has(key)) {
              if (shouldWriteUpdate(collection, key, item.value)) {
                normalized.push({ type: "update", value: item.value });
              }
              continue;
            }
            normalized.push({ type, value: item.value });
          }

          if (maxRows && liveKeys.size > maxRows) {
            const overflow = Array.from(liveKeys).sort(keySort).slice(0, liveKeys.size - maxRows);
            const overflowKeys = new Set(overflow);
            normalized = normalized.filter((item) =>
              item.type === "delete" || !overflowKeys.has(config.getKey(item.value))
            );
            for (const key of overflow) {
              if (!deleted.has(key) && collection.has(key)) {
                normalized.push({ type: "delete", key });
              }
            }
          }

          if (normalized.length === 0) return;
          begin();
          for (const item of normalized) {
            if (item.type === "delete") {
              write({ type: "delete", key: item.key });
            } else {
              write({ type: item.type, value: item.value });
            }
          }
          commit();
        };

        const replaceRows = (rows: readonly TRow[], maxRows?: number) => {
          const nextKeys = new Set(rows.map((row) => config.getKey(row)));
          const writes: Array<GatewayCollectionWrite<TRow, TKey>> = [];
          for (const row of rows) {
            const key = config.getKey(row);
            if (!collection.has(key)) {
              writes.push({ type: "insert", value: row });
              continue;
            }
            if (shouldWriteUpdate(collection, key, row)) {
              writes.push({ type: "update", value: row });
            }
          }
          for (const key of collection.keys()) {
            if (!nextKeys.has(key)) {
              writes.push({ type: "delete", key });
            }
          }
          applyWrites(writes, maxRows);
        };

        const refetchRows = async () => {
          if (!config.method) return [];
          const payload = await config.client.rpc(config.method, config.params ?? {}, { signal });
          if (signal.aborted) return [];
          return toArray(await rowsFromPayload(payload));
        };

        const applyFrame = async (frame: SyncStreamFrame) => {
          if (!stream || signal.aborted) return;
          if (stream.frameToWrites) {
            applyWrites(toArray(await stream.frameToWrites(frame, { collection, signal })), stream.maxRows);
            return;
          }
          if (stream.frameToRows) {
            const rows = toArray(await stream.frameToRows(frame, { collection, signal }));
            applyWrites(rows.map((value) => ({ type: "upsert" as const, value })), stream.maxRows);
            return;
          }
          if (stream.refetchOnFrame) {
            const rows = await refetchRows();
            if (stream.refetchMode === "upsert") {
              applyWrites(rows.map((value) => ({ type: "upsert" as const, value })), stream.maxRows);
            } else {
              replaceRows(rows, stream.maxRows);
            }
          }
        };

        const enqueueFrame = (frame: SyncStreamFrame) => {
          if (!initialComplete) {
            buffered.push(frame);
            return;
          }
          applyChain = applyChain
            .then(() => applyFrame(frame))
            .catch(handleError);
        };

        const openStreamLoop = async () => {
          if (!stream) return;
          if (!config.client.stream) {
            throw new Error("Gateway collection stream requested, but client has no stream implementation.");
          }
          let afterSeq = stream.afterSeq;
          let attempt = 0;
          while (!signal.aborted) {
            let threw = false;
            try {
              const iterable = config.client.stream(stream.scope, stream.params, { signal, afterSeq });
              for await (const frame of iterable) {
                if (signal.aborted) return;
                attempt = 0;
                if (typeof frame.seq === "number") {
                  afterSeq = frame.seq;
                }
                enqueueFrame(frame);
              }
            } catch (cause) {
              threw = true;
              const error = asError(cause);
              if (isAuthError(error)) {
                config.onAuthError?.(error);
                return;
              }
              config.onError?.(error);
            }
            if (signal.aborted) return;
            const shouldReconnect = threw || stream.reconnectOnGracefulEnd === true || (
              stream.reconnectOnGracefulEnd === undefined && stream.scope === "streamDevTools"
            );
            if (!shouldReconnect) return;
            await sleep(syncBackoffDelay(attempt, stream.backoff), signal);
            attempt += 1;
          }
        };

        const loadInitial = async () => {
          try {
            if (config.method) {
              replaceRows(await refetchRows(), stream?.maxRows);
            }
            initialComplete = true;
            for (const frame of buffered.splice(0)) {
              applyChain = applyChain
                .then(() => applyFrame(frame))
                .catch(handleError);
            }
            await applyChain;
          } catch (cause) {
            initialComplete = true;
            buffered.length = 0;
            handleError(cause);
          } finally {
            if (!signal.aborted) {
              markReady();
            }
          }
        };

        void openStreamLoop().catch(handleError);
        void loadInitial();

        return () => {
          controller.abort();
        };
      },
    },
  };
}
