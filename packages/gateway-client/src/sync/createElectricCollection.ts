import { deepEquals, type CollectionConfig } from "@tanstack/db";
import type { SyncKey } from "./SyncKey.ts";
import { syncKeyFingerprint } from "./SyncKey.ts";

/**
 * The cloud sibling of `createGatewayCollection`. Where the gateway source feeds
 * a collection from the Gateway RPC (initial load) + WebSocket stream, this
 * source feeds the SAME `@tanstack/db` `CollectionConfig` from an ElectricSQL
 * shape: `GET /v1/shape?table=…` for the initial snapshot and the live long-poll
 * tail for change events. The two are interchangeable behind a single
 * `CollectionConfig`, so a surface (e.g. `/memory` via `useGatewayMemoryFacts`)
 * consumes whichever the registry selected with zero changes.
 *
 * Wire-format handling lives in the per-collection `mapRow`: Electric delivers
 * each row as `{ value: { <snake_case columns> } }` where int8 columns arrive as
 * decimal STRINGS and JSON columns as JSON strings. `mapRow` turns one raw
 * Electric `value` into the typed, camelCased Row the gateway path also emits
 * (e.g. `value_json` string → kept as-is, `created_at_ms` string → number), so
 * downstream code never branches on the source.
 *
 * The `@electric-sql/client` `ShapeStream` runtime is loaded with a DYNAMIC
 * import so the cloud-Electric code path is tree-shaken out of bundles that only
 * use the gateway transport — local builds never pay for it.
 */

/** One raw Electric shape row `value`: every column as Electric serialized it. */
export type ElectricRawRow = Record<string, unknown>;

export type ElectricCollectionDef<TRow extends object, TKey extends string | number> = {
  /** Same `SyncKey` the gateway def uses → same collection-id fingerprint. */
  key: SyncKey;
  /** Composite/primary key extractor over the MAPPED row (matches the gateway def). */
  getKey: (row: TRow) => TKey;
  /** Postgres table the shape is served from, e.g. `_smithers_memory_facts`. */
  table: string;
  /** Optional SQL `where` for the shape (server-side row filter). */
  where?: string;
  /**
   * Map one raw Electric row `value` (snake_case columns, int8→string,
   * json→string) into the typed Row the collection stores. Returning
   * `undefined` drops the row (e.g. a malformed/partial value). This is the
   * single place the Electric wire format is decoded.
   */
  mapRow: (raw: ElectricRawRow) => TRow | undefined;
};

export type ElectricCollectionConfig = {
  /**
   * Absolute Electric shape URL, e.g. `http://localhost:3000/v1/shape` or the
   * same-origin `/v1/shape` Vite proxy resolved to an absolute URL. The
   * `ShapeStream` constructs `new URL(url)`, so it must be absolute.
   */
  shapeUrl: string;
  /** Optional headers attached to every shape request (auth/proxy). */
  headers?: Record<string, string>;
  gcTime?: number;
  startSync?: boolean;
  onError?: (error: Error) => void;
};

function asError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
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

/** A minimal structural view of an `@electric-sql/client` change message. */
type ElectricChangeMessage = {
  value: ElectricRawRow;
  old_value?: ElectricRawRow;
  headers: { operation: "insert" | "update" | "delete" };
};

/** A minimal structural view of an `@electric-sql/client` control message. */
type ElectricControlMessage = {
  headers: { control: "up-to-date" | "must-refetch" | "snapshot-end" | "subset-end" };
};

type ElectricMessage = ElectricChangeMessage | ElectricControlMessage;

function isChange(message: ElectricMessage): message is ElectricChangeMessage {
  return "value" in message && typeof (message as ElectricChangeMessage).headers?.operation === "string";
}

function isUpToDate(message: ElectricMessage): message is ElectricControlMessage {
  return (message as ElectricControlMessage).headers?.control === "up-to-date";
}

/**
 * Lazily import the Electric ShapeStream constructor. Kept behind a dynamic
 * import so the gateway-only bundle never pulls `@electric-sql/client`.
 */
async function loadShapeStream(): Promise<
  new (options: {
    url: string;
    params?: Record<string, unknown>;
    headers?: Record<string, string>;
    signal?: AbortSignal;
  }) => {
    subscribe(
      callback: (messages: ElectricMessage[]) => void | Promise<void>,
      onError?: (error: Error) => void,
    ): () => void;
  }
> {
  const mod = (await import("@electric-sql/client")) as {
    ShapeStream: new (options: {
      url: string;
      params?: Record<string, unknown>;
      headers?: Record<string, string>;
      signal?: AbortSignal;
    }) => {
      subscribe(
        callback: (messages: ElectricMessage[]) => void | Promise<void>,
        onError?: (error: Error) => void,
      ): () => void;
    };
  };
  return mod.ShapeStream;
}

/**
 * Build the `CollectionConfig` for a cloud-Electric–backed collection. The
 * returned config is structurally interchangeable with the one from
 * `createGatewayCollection`: same `id` (so the registry caches it identically),
 * same `getKey`, and a `sync` that drives the collection's begin/write/commit —
 * here from the Electric shape rather than the gateway transport.
 */
export function createElectricCollection<TRow extends object, TKey extends string | number = string>(
  def: ElectricCollectionDef<TRow, TKey>,
  config: ElectricCollectionConfig,
): CollectionConfig<TRow, TKey> {
  const id = syncKeyFingerprint(def.key);
  return {
    id,
    getKey: def.getKey,
    ...(config.gcTime === undefined ? {} : { gcTime: config.gcTime }),
    ...(config.startSync === undefined ? {} : { startSync: config.startSync }),
    sync: {
      rowUpdateMode: "full",
      sync: ({ begin, write, commit, markReady, collection }) => {
        const controller = new AbortController();
        const signal = controller.signal;
        // Electric delivers a snapshot as a burst of change messages followed by
        // an `up-to-date` control. We buffer one transaction's worth of changes
        // and flush on each `up-to-date`, so the collection commits atomically
        // (snapshot first, then each live batch).
        let pending: ElectricChangeMessage[] = [];
        let ready = false;

        const handleError = (cause: unknown) => {
          if (signal.aborted) return;
          config.onError?.(asError(cause));
        };

        const flush = () => {
          const batch = pending;
          pending = [];
          // Resolve each change to the typed row + the collection's key, then
          // collapse inserts/updates the same way the gateway path does (no-op
          // writes are skipped; an insert onto an existing key becomes an update).
          type Resolved =
            | { type: "insert" | "update"; key: TKey; value: TRow }
            | { type: "delete"; key: TKey };
          const resolved: Resolved[] = [];
          for (const message of batch) {
            const operation = message.headers.operation;
            const raw = operation === "delete" ? (message.old_value ?? message.value) : message.value;
            const mapped = def.mapRow(raw);
            if (mapped === undefined) continue;
            const key = def.getKey(mapped);
            if (operation === "delete") {
              if (collection.has(key)) resolved.push({ type: "delete", key });
              continue;
            }
            const exists = collection.has(key);
            if (!exists) {
              resolved.push({ type: "insert", key, value: mapped });
              continue;
            }
            const current = collection.get(key);
            if (current && deepEquals(withoutVirtualFields(current), mapped)) continue;
            resolved.push({ type: "update", key, value: mapped });
          }
          if (resolved.length > 0) {
            begin();
            for (const item of resolved) {
              if (item.type === "delete") {
                write({ type: "delete", key: item.key });
              } else {
                write({ type: item.type, value: item.value });
              }
            }
            commit();
          }
          if (!ready) {
            ready = true;
            if (!signal.aborted) markReady();
          }
        };

        void (async () => {
          try {
            const ShapeStream = await loadShapeStream();
            if (signal.aborted) return;
            const stream = new ShapeStream({
              url: config.shapeUrl,
              params: {
                table: def.table,
                ...(def.where ? { where: def.where } : {}),
              },
              ...(config.headers ? { headers: config.headers } : {}),
              signal,
            });
            stream.subscribe((messages) => {
              for (const message of messages) {
                if (isChange(message)) {
                  pending.push(message);
                } else if (isUpToDate(message)) {
                  flush();
                }
              }
            }, handleError);
          } catch (cause) {
            handleError(cause);
            // Never strand the collection in a non-ready state on a load failure.
            if (!ready && !signal.aborted) {
              ready = true;
              markReady();
            }
          }
        })();

        return () => {
          controller.abort();
        };
      },
    },
  };
}
