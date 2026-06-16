import { deepEquals, type Collection, type CollectionConfig } from "@tanstack/db";
import type { SyncBackoffOptions } from "./SyncBackoff.ts";
import { syncBackoffDelay } from "./SyncBackoff.ts";
import type { SyncKey } from "./SyncKey.ts";
import { syncKeyFingerprint } from "./SyncKey.ts";
import type { SyncStreamFrame, SyncTransport } from "./SyncTransport.ts";
import { emitSyncTelemetry, syncLagMs } from "./syncTelemetry.ts";

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

export type GatewayCollectionStreamConfig<TRow extends object, TKey extends string | number> = {
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
  /**
   * Hard cap on the in-flight frame queue (frames received but not yet applied,
   * including those buffered before the initial load commits). When the queue
   * exceeds this, the OLDEST unprocessed frame is shed and counted, so a slow
   * consumer or a burst can never grow memory without bound. Defaults to
   * `max(maxRows, 1024)`. `maxRows` bounds the stored rows; this bounds the
   * apply backlog.
   */
  maxBufferedFrames?: number;
  backoff?: SyncBackoffOptions;
};

const DEFAULT_MAX_BUFFERED_FRAMES = 1024;

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
  onReady?: () => void;
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

/**
 * Largest numeric key already in the collection, or undefined when there are
 * none. After a persisted seq-keyed collection (runEvents) rehydrates, this is
 * the resume cursor: the stream must reopen with `afterSeq = max(cached seq)`
 * so the gateway replays frames produced between the cached max and the new
 * subscription instead of dropping them. String-keyed collections return
 * undefined and fall back to the gateway's default replay window.
 */
function maxNumericKey<TRow extends object, TKey extends string | number>(
  collection: Collection<TRow, TKey>,
): number | undefined {
  let max: number | undefined;
  for (const key of collection.keys()) {
    if (typeof key === "number" && (max === undefined || key > max)) max = key;
  }
  return max;
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
        // ONE bounded queue for every frame not yet applied — the ones buffered
        // before the initial load commits AND the live backlog when the consumer
        // (apply) is slower than the producer (stream). A single drain loop
        // applies them in order; on overflow the oldest is shed and counted.
        // This replaces an unbounded pre-load array plus an unbounded promise
        // chain, either of which grew without limit under a burst.
        const queue: SyncStreamFrame[] = [];
        // An explicit `maxBufferedFrames` wins as-is (lets a caller tune the cap
        // down); otherwise default to a generous bound that still scales with a
        // ring collection's own `maxRows`.
        const maxQueued = stream?.maxBufferedFrames
          ?? Math.max(stream?.maxRows ?? 0, DEFAULT_MAX_BUFFERED_FRAMES);
        let initialComplete = false;
        let draining = false;
        let droppedFrames = 0;

        const handleError = (cause: unknown) => {
          if (signal.aborted) return;
          const error = asError(cause);
          emitSyncTelemetry({
            type: "sync.error",
            collectionId: id,
            key: config.key,
            scope: stream?.scope,
            error: error.message,
          });
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

        const drainQueue = async () => {
          if (draining) return;
          draining = true;
          try {
            while (initialComplete && !signal.aborted && queue.length > 0) {
              const frame = queue.shift() as SyncStreamFrame;
              try {
                await applyFrame(frame);
              } catch (cause) {
                handleError(cause);
              }
            }
          } finally {
            draining = false;
          }
        };

        const enqueueFrame = (frame: SyncStreamFrame) => {
          queue.push(frame);
          if (queue.length > maxQueued) {
            // Shed the oldest unapplied frame. The collection's `maxRows` still
            // bounds stored rows; this bounds the apply backlog so a slow
            // consumer under a burst cannot grow memory without bound.
            queue.shift();
            droppedFrames += 1;
            emitSyncTelemetry({
              type: "sync.backpressure",
              collectionId: id,
              key: config.key,
              scope: stream?.scope,
              dropped: droppedFrames,
            });
          }
          void drainQueue();
        };

        const openStreamLoop = async () => {
          if (!stream) return;
          if (!config.client.stream) {
            throw new Error("Gateway collection stream requested, but client has no stream implementation.");
          }
          // Resume from the cached high-water mark so frames produced between a
          // persisted reload and this subscription are replayed, not lost.
          let afterSeq = stream.afterSeq ?? maxNumericKey(collection);
          let attempt = 0;
          // Tracks whether the last stream attempt reported an error so a
          // successful reconnect can clear the sticky 'error' status instead of
          // leaving a recovered, live stream showing an error forever.
          let streamErrored = false;
          while (!signal.aborted) {
            let threw = false;
            try {
              const iterable = config.client.stream(stream.scope, stream.params, { signal, afterSeq });
              for await (const frame of iterable) {
                if (signal.aborted) return;
                attempt = 0;
                if (streamErrored) {
                  streamErrored = false;
                  emitSyncTelemetry({
                    type: "sync.reconnect",
                    collectionId: id,
                    key: config.key,
                    scope: stream.scope,
                  });
                  // Flip the per-collection status back to success on the first
                  // frame after a recovered transient error.
                  config.onReady?.();
                }
                if (typeof frame.seq === "number") {
                  afterSeq = frame.seq;
                }
                emitSyncTelemetry({
                  type: "sync.frame",
                  collectionId: id,
                  key: config.key,
                  scope: stream.scope,
                  seq: frame.seq,
                  lagMs: syncLagMs(frame.payload),
                });
                enqueueFrame(frame);
              }
            } catch (cause) {
              threw = true;
              const error = asError(cause);
              if (
                (error as { code?: unknown }).code === "SeqOutOfRange" ||
                /SeqOutOfRange|GapResync|replay gap/i.test(error.message)
              ) {
                emitSyncTelemetry({
                  type: "sync.gap_resync",
                  collectionId: id,
                  key: config.key,
                  scope: stream.scope,
                  error: error.message,
                });
              }
              if (isAuthError(error)) {
                config.onAuthError?.(error);
                return;
              }
              streamErrored = true;
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
              const rows = await refetchRows();
              replaceRows(rows, stream?.maxRows);
              emitSyncTelemetry({
                type: "sync.initial_load",
                collectionId: id,
                key: config.key,
                scope: stream?.scope,
                count: rows.length,
              });
            }
            initialComplete = true;
            // Apply the frames buffered during the initial load before signaling
            // ready, so a reload's first paint already reflects them.
            await drainQueue();
            config.onReady?.();
          } catch (cause) {
            initialComplete = true;
            queue.length = 0;
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
