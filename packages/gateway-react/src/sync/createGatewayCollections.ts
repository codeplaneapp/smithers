import { createCollection, type Collection, type CollectionConfig } from "@tanstack/react-db";
import {
  createGatewayCollection,
  createGatewaySyncSource,
  gatewayCollectionDefs,
  syncKeyFingerprint,
  syncKeyMatches,
  type CollectionDef,
  type GatewayApprovalRow,
  type GatewayRunEventRow,
  type GatewayRunNode,
  type GatewayRunRow,
  type GatewayRunSummaryRow,
  type GatewayWorkflowRow,
  type SyncKey,
  type SyncSource,
  type SyncStreamFrame,
  type SyncTransport,
} from "@smithers-orchestrator/gateway-client";
import type {
  ListApprovalsRequest,
  ListRunsRequest,
  ListWorkflowsRequest,
} from "@smithers-orchestrator/gateway/rpc";
import type {
  GatewayCollectionStatusRow,
  GatewayCollections,
  GatewayQueryHandle,
  GatewayQueryRow,
  GatewayStreamHandle,
  GatewayStreamRow,
} from "./GatewayCollections.ts";
import type { PersistenceAdapter } from "./PersistenceAdapter.ts";
import { persistedCollectionOptions } from "./persistedCollectionOptions.ts";
import { resolveLazy, type LazyValue } from "./resolveLazy.ts";

/**
 * Status hooks a `SyncSource` calls so the registry can surface per-collection
 * load state (the PR #286 error-surfacing edge). Passed to a `createSource`
 * factory so a source chosen at app boot is wired into the same status sidecar
 * as the built-in gateway source — a pre-built `source` object that does not
 * call these would otherwise report every load as a silent success.
 */
export type SyncSourceHooks = {
  onAuthError?: (error: Error) => void;
  onCollectionError?: (id: string, error: Error) => void;
  onCollectionReady?: (id: string) => void;
};

export type CreateGatewayCollectionsOptions = {
  source?: SyncSource;
  /** Source factory selected at app boot (e.g. from `backendStore`); wired with
   *  the registry's status hooks. Preferred over `source` for real apps. */
  createSource?: (hooks: SyncSourceHooks) => SyncSource;
  client?: SyncTransport;
  onAuthError?: (error: Error) => void;
  listGcTime?: number;
  persistence?: LazyValue<PersistenceAdapter | undefined>;
  schemaVersion?: LazyValue<string>;
};

const LIST_GC_TIME = 5 * 60_000;
const RUN_GC_TIME = 0;
const DEFAULT_SCHEMA_VERSION = "0016";

function asError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}

export function createGatewayCollections(
  options: CreateGatewayCollectionsOptions,
): GatewayCollections {
  const listGcTime = options.listGcTime ?? LIST_GC_TIME;

  // Resolve the persistence adapter at most once and share that single instance
  // across every collection. Resolving the lazy value per collection (the old
  // behavior) constructed an independent adapter each time; adapters that hold
  // an in-memory snapshot (the OPFS-JSON web cache) would then clobber each
  // other's durable state. One shared adapter, keyed internally by collectionId,
  // keeps the durable copy consistent across collections.
  let sharedPersistence: Promise<PersistenceAdapter | undefined> | undefined;
  const persistenceThunk: LazyValue<PersistenceAdapter | undefined> | undefined =
    options.persistence === undefined
      ? undefined
      : () => (sharedPersistence ??= resolveLazy(options.persistence!));

  type QueryHandleInternal<T> = GatewayQueryHandle<T> & {
    fetcher: () => Promise<T>;
    read: () => T | undefined;
    set: (value: T) => { previous: T | undefined };
  };

  const collections = new Map<string, Collection<object, string | number>>();
  const queries = new Map<string, QueryHandleInternal<unknown>>();
  const queryKeyById = new Map<string, SyncKey>();
  const streams = new Map<string, GatewayStreamHandle>();
  const collectionStatusRows = new Map<string, GatewayCollectionStatusRow>();
  let writeCollectionStatusRow: ((row: GatewayCollectionStatusRow) => void) | null = null;
  const statusCollection = createCollection<GatewayCollectionStatusRow, string>({
    id: "gateway:collection-status",
    getKey: (row) => row.key,
    gcTime: Number.POSITIVE_INFINITY,
    startSync: true,
    sync: {
      sync: ({ begin, write, commit, markReady, collection }) => {
        writeCollectionStatusRow = (row) => {
          collectionStatusRows.set(row.key, row);
          begin();
          write({ type: collection.has(row.key) ? "update" : "insert", value: row });
          commit();
        };
        for (const row of collectionStatusRows.values()) writeCollectionStatusRow(row);
        markReady();
        return () => {
          writeCollectionStatusRow = null;
        };
      },
    },
  });

  const writeCollectionStatus = (id: string, status: GatewayCollectionStatusRow["status"], error?: Error) => {
    const current = collectionStatusRows.get(id);
    const row: GatewayCollectionStatusRow = {
      key: id,
      status,
      error,
      revision: (current?.revision ?? 0) + 1,
    };
    collectionStatusRows.set(id, row);
    writeCollectionStatusRow?.(row);
  };

  const sourceHooks: SyncSourceHooks = {
    onAuthError: options.onAuthError,
    onCollectionError: (id, error) => writeCollectionStatus(id, "error", error),
    onCollectionReady: (id) => writeCollectionStatus(id, "success", undefined),
  };
  const source = options.source
    ?? options.createSource?.(sourceHooks)
    ?? createGatewaySyncSource({
      transport: options.client ?? {
        rpc: () => Promise.reject(new Error("Gateway SyncSource requires a SyncTransport for RPC.")),
      },
      ...sourceHooks,
    });
  const sourceWithClient = source as SyncSource & { client?: SyncTransport; invalidate?: (prefix: SyncKey) => void };
  const transport = sourceWithClient.client ?? options.client ?? {
    rpc: () => Promise.reject(new Error("GatewayCollections was created without an RPC transport.")),
  };

  function withCollectionStatus<TRow extends object, TKey extends string | number>(
    id: string,
    config: CollectionConfig<TRow, TKey>,
  ): CollectionConfig<TRow, TKey> {
    const sync = config.sync;
    return {
      ...config,
      sync: {
        ...sync,
        sync(api) {
          writeCollectionStatus(id, "loading", undefined);
          try {
            return sync.sync({
              ...api,
              markReady: () => {
                if (collectionStatusRows.get(id)?.status !== "error") {
                  writeCollectionStatus(id, "success", undefined);
                }
                api.markReady();
              },
            });
          } catch (cause) {
            writeCollectionStatus(id, "error", asError(cause));
            throw cause;
          }
        },
      },
    };
  }

  function knownCollection<TRow extends object, TKey extends string | number>(
    def: CollectionDef<TRow, TKey>,
    gcTime: number,
  ): Collection<TRow, TKey> {
    const id = syncKeyFingerprint(def.key);
    const existing = collections.get(id);
    if (existing) return existing as unknown as Collection<TRow, TKey>;
    // Do NOT write "loading" here. `knownCollection` is called from hooks during
    // React render; writing to the shared status collection synchronously would
    // update any other component already subscribed to it (the React
    // "setState while rendering a different component" warning). The "loading"
    // transition is written by `withCollectionStatus` when the collection's sync
    // actually starts, which happens in an effect (startSync:false), off-render.
    const sourceConfig = source.collection(def);
    const statusConfig = withCollectionStatus(id, {
      ...sourceConfig,
      gcTime,
      startSync: false,
    });
    const collectionOptions = def.persisted && persistenceThunk
      ? persistedCollectionOptions<TRow, TKey>({
          ...statusConfig,
          persistence: persistenceThunk,
          schemaVersion: options.schemaVersion ?? DEFAULT_SCHEMA_VERSION,
          ...(def.maxRows !== undefined ? { maxRows: def.maxRows } : {}),
          ...(def.sanitizeForPersistence ? { sanitizeRow: def.sanitizeForPersistence } : {}),
        })
      : statusConfig;
    const collection = createCollection<TRow, TKey>(collectionOptions);
    collections.set(id, collection as unknown as Collection<object, string | number>);
    return collection;
  }

  function queryHandle<T>(key: SyncKey, fetcher: () => Promise<T>): GatewayQueryHandle<T> {
    const id = syncKeyFingerprint(key);
    const existing = queries.get(id) as QueryHandleInternal<T> | undefined;
    if (existing) {
      existing.fetcher = fetcher;
      return existing;
    }

    let writeRow: ((row: GatewayQueryRow<T>) => void) | null = null;
    let current: GatewayQueryRow<T> = { key: id, status: "idle", value: undefined, error: undefined, revision: 0 };
    let generation = 0;

    const write = (next: GatewayQueryRow<T>) => {
      current = next;
      writeRow?.(next);
    };

    const runFetch = async (): Promise<T | undefined> => {
      const gen = ++generation;
      write({ ...current, status: "loading", error: undefined, revision: current.revision + 1 });
      try {
        const value = await api.fetcher();
        if (gen !== generation) return current.value;
        write({ key: id, status: "success", value, error: undefined, revision: current.revision + 1 });
        return value;
      } catch (cause) {
        if (gen !== generation) return current.value;
        write({ ...current, status: "error", error: asError(cause), revision: current.revision + 1 });
        return undefined;
      }
    };

    const collection = createCollection<GatewayQueryRow<T>, string>({
      id,
      getKey: (row) => row.key,
      gcTime: listGcTime,
      startSync: false,
      sync: {
        sync: ({ begin, write: syncWrite, commit, markReady, collection: coll }) => {
          writeRow = (row) => {
            begin();
            syncWrite({ type: coll.has(row.key) ? "update" : "insert", value: row });
            commit();
          };
          writeRow(current);
          void runFetch().finally(() => markReady());
          return () => {
            writeRow = null;
          };
        },
      },
    });

    const api: QueryHandleInternal<T> = {
      collection,
      refetch: runFetch,
      fetcher,
      read: () => current.value,
      set: (value: T) => {
        const previous = current.value;
        write({ key: id, status: "success", value, error: undefined, revision: current.revision + 1 });
        return { previous };
      },
    };
    queries.set(id, api as QueryHandleInternal<unknown>);
    queryKeyById.set(id, key);
    return api;
  }

  function streamHandle(key: SyncKey, scope: string, params: unknown, maxFrames: number): GatewayStreamHandle {
    const id = `${syncKeyFingerprint(key)}|${scope}|${syncKeyFingerprint(["params", params])}|${maxFrames}`;
    const existing = streams.get(id);
    if (existing) return existing;

    const stats = { totalSeen: 0 };
    let nextSynthetic = -1;
    const collection = createCollection<GatewayStreamRow, number>(
      createGatewayCollection<GatewayStreamRow, number>({
        key,
        client: transport,
        getKey: (row) => row.id,
        gcTime: RUN_GC_TIME,
        startSync: false,
        stream: {
          scope,
          params,
          maxRows: maxFrames,
          frameToRows: (frame) => {
            stats.totalSeen += 1;
            const rowId = typeof frame.seq === "number" ? frame.seq : nextSynthetic--;
            return [{ id: rowId, frame }];
          },
        },
      }),
    );
    const handle: GatewayStreamHandle = { collection, stats };
    streams.set(id, handle);
    return handle;
  }

  return {
    client: transport,
    rpc: <T,>(method: string, params: unknown, opts?: { signal?: AbortSignal }) =>
      transport.rpc(method, params, opts) as Promise<T>,

    invalidate: async (prefix: SyncKey) => {
      sourceWithClient.invalidate?.(prefix);
      for (const [id, query] of queries.entries()) {
        const key = queryKeyById.get(id);
        if (key && syncKeyMatches(key, prefix)) void query.refetch();
      }
    },

    runs: (params: ListRunsRequest = {}) =>
      knownCollection<GatewayRunSummaryRow, string>(gatewayCollectionDefs.runs(params), listGcTime),
    run: (runId: string) =>
      knownCollection<GatewayRunRow, string>(gatewayCollectionDefs.run(runId), RUN_GC_TIME),
    workflows: (params: ListWorkflowsRequest = {}) =>
      knownCollection<GatewayWorkflowRow, string>(gatewayCollectionDefs.workflows(params), listGcTime),
    approvals: (params: ListApprovalsRequest = {}) =>
      knownCollection<GatewayApprovalRow, string>(gatewayCollectionDefs.approvals(params), listGcTime),
    nodes: (runId: string) =>
      knownCollection<GatewayRunNode, string>(gatewayCollectionDefs.nodes(runId), RUN_GC_TIME),
    runEvents: (runId: string) =>
      knownCollection<GatewayRunEventRow, number>(gatewayCollectionDefs.runEvents(runId), RUN_GC_TIME),

    query: queryHandle,
    stream: streamHandle,
    collectionStatus: (key: SyncKey) => {
      const id = syncKeyFingerprint(key);
      if (!collectionStatusRows.has(id)) {
        collectionStatusRows.set(id, { key: id, status: "idle", error: undefined, revision: 0 });
      }
      return statusCollection;
    },

    getQueryData: <T,>(key: SyncKey): T | undefined => {
      const handle = queries.get(syncKeyFingerprint(key)) as QueryHandleInternal<T> | undefined;
      return handle?.read();
    },
    setQueryData: <T,>(key: SyncKey, value: T): { previous: T | undefined } => {
      const handle = queries.get(syncKeyFingerprint(key)) as QueryHandleInternal<T> | undefined;
      return handle ? handle.set(value) : { previous: undefined };
    },

    connection: source.status().get,
    subscribeConnection: source.status().subscribe,

    connect: async () => {
      await transport.rpc("listRuns", {}).catch(() => undefined);
    },

    reset: () => {
      for (const collection of collections.values()) void collection.cleanup();
      for (const handle of queries.values()) void handle.collection.cleanup();
      for (const handle of streams.values()) void handle.collection.cleanup();
      void statusCollection.cleanup();
      collections.clear();
      queries.clear();
      queryKeyById.clear();
      streams.clear();
      collectionStatusRows.clear();
      source.reset?.();
      // Reset the shared adapter (whether it was a direct value or lazily
      // constructed) and drop the memo so the next mount builds a fresh one.
      if (sharedPersistence) {
        const pending = sharedPersistence;
        sharedPersistence = undefined;
        void pending.then((adapter) => adapter?.reset?.());
      }
    },
  };
}
