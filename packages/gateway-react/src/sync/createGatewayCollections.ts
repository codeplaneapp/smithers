import { createCollection, type Collection } from "@tanstack/react-db";
import {
  createGatewayCollection,
  gatewayCollectionDefs,
  syncKeyFingerprint,
  syncKeyMatches,
  type GatewayApprovalRow,
  type GatewayCollectionConfig,
  type GatewayCronRow,
  type GatewayMemoryFactRow,
  type GatewayPromptRow,
  type GatewayScoreRow,
  type GatewayTicketRow,
  type GatewayRunEventRow,
  type GatewayRunNode,
  type GatewayRunRow,
  type GatewayRunSummaryRow,
  type GatewayWorkflowRow,
  type SyncKey,
  type SyncStreamFrame,
  type SyncStreamOptions,
  type SyncTransport,
} from "@smithers-orchestrator/gateway-client";
import type {
  CronListRequest,
  ListApprovalsRequest,
  ListMemoryFactsRequest,
  ListPromptsRequest,
  ListRunsRequest,
  ListScoresRequest,
  ListTicketsRequest,
  ListWorkflowsRequest,
} from "@smithers-orchestrator/gateway/rpc";
import type { GatewayConnectionState } from "./GatewayConnectionState.ts";
import type {
  GatewayCollections,
  GatewayQueryHandle,
  GatewayQueryRow,
  GatewayStreamHandle,
  GatewayStreamRow,
} from "./GatewayCollections.ts";
import type { GatewayCollectionStore } from "./persistence/PersistentCollectionStore.ts";
import { withPersistence } from "./persistence/withPersistence.ts";

export type CreateGatewayCollectionsOptions = {
  /**
   * The instrumented transport — apps/smithers passes one built over its
   * wrapped `getGatewayClient()` (so auth/CSRF/proxy/observability are
   * preserved); `createGatewayReactRoot` passes `createSmithersGatewayTransport`
   * over a fresh client.
   */
  client: SyncTransport;
  /** Top-level auth bailout (apps/smithers wires this to `handleAuthRequired`). */
  onAuthError?: (error: Error) => void;
  /** gcTime for the pollable list/query collections. Default 5 min. */
  listGcTime?: number;
  /**
   * Opt-in client-side persistence. When supplied (the app builds it with
   * `createGatewayPersistence` over a SQLite-WASM/OPFS store), the *pollable list*
   * collections (runs/approvals/crons/memory/scores/tickets/prompts/workflows)
   * hydrate from the cache on the first render after a reload — no re-seed, no
   * fetch flash — and write through every live change for the next reload.
   *
   * Per-run streamed collections (run/nodes/runEvents, `gcTime: 0`) are
   * deliberately NOT persisted: they are ephemeral and re-stream on demand.
   *
   * Omit it and the registry behaves exactly as before (live-only). The live
   * gateway path is never gated on persistence.
   */
  persistence?: { store: GatewayCollectionStore };
};

/** Pseudo stream scope the registry uses to drive `invalidate()` re-pulls. */
const INVALIDATE_SCOPE = "smithers:invalidate";
const LIST_GC_TIME = 5 * 60_000;
/** Per-run streamed collections tear down promptly so navigating away aborts the WS. */
const RUN_GC_TIME = 0;

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

type ConnectionObserver = {
  get(): GatewayConnectionState;
  subscribe(listener: () => void): () => void;
  markConnecting(): void;
  markOnline(): void;
  markOffline(): void;
  markUnauthorized(): void;
  reset(): void;
};

function createConnectionObserver(): ConnectionObserver {
  let state: GatewayConnectionState = { status: "idle" };
  const listeners = new Set<() => void>();
  const set = (next: GatewayConnectionState) => {
    if (next.status === state.status && next.reconnectingSince === state.reconnectingSince) return;
    state = next;
    for (const listener of listeners) listener();
  };
  return {
    get: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    markConnecting: () => {
      if (state.status === "idle") set({ status: "connecting" });
    },
    markOnline: () => set({ status: "online" }),
    markOffline: () =>
      set({ status: "offline", reconnectingSince: state.reconnectingSince ?? Date.now() }),
    markUnauthorized: () => set({ status: "unauthorized" }),
    reset: () => set({ status: "idle" }),
  };
}

/**
 * Per-fingerprint pulse bus backing `invalidate()`. A collection subscribes to
 * its own fingerprint through the `INVALIDATE_SCOPE` pseudo-stream;
 * `invalidate()` pulses the fingerprint, which `createGatewayCollection`'s
 * `refetchOnFrame` turns into a fresh RPC + reconcile.
 */
function createPulser() {
  const waiters = new Map<string, Set<() => void>>();
  return {
    pulse(fingerprint: string) {
      const set = waiters.get(fingerprint);
      if (!set || set.size === 0) return;
      const pending = Array.from(set);
      set.clear();
      for (const resolve of pending) resolve();
    },
    stream(fingerprint: string, signal: AbortSignal): AsyncIterable<SyncStreamFrame> {
      return {
        async *[Symbol.asyncIterator]() {
          while (!signal.aborted) {
            await new Promise<void>((resolve) => {
              if (signal.aborted) {
                resolve();
                return;
              }
              const set = waiters.get(fingerprint) ?? new Set();
              set.add(resolve);
              waiters.set(fingerprint, set);
              signal.addEventListener(
                "abort",
                () => {
                  set.delete(resolve);
                  resolve();
                },
                { once: true },
              );
            });
            if (signal.aborted) return;
            yield { key: ["smithers:invalidate", fingerprint], event: "invalidate", payload: undefined };
          }
        },
      };
    },
  };
}

export function createGatewayCollections(
  options: CreateGatewayCollectionsOptions,
): GatewayCollections {
  const listGcTime = options.listGcTime ?? LIST_GC_TIME;
  const connection = createConnectionObserver();
  const pulser = createPulser();
  const base = options.client;
  const persistenceStore = options.persistence?.store;

  // Instrument the transport so connection status and the top-level auth bailout
  // are derived from real traffic, and so the `INVALIDATE_SCOPE` pseudo-stream is
  // served locally rather than forwarded to the gateway.
  const transport: SyncTransport = {
    async rpc(method, params, opts) {
      connection.markConnecting();
      try {
        const result = await base.rpc(method, params, opts);
        connection.markOnline();
        return result;
      } catch (cause) {
        const error = asError(cause);
        if (isAuthError(error)) {
          connection.markUnauthorized();
          options.onAuthError?.(error);
        } else {
          connection.markOffline();
        }
        throw error;
      }
    },
    stream(scope, params, streamOptions: SyncStreamOptions) {
      if (scope === INVALIDATE_SCOPE) {
        const fingerprint = typeof params === "string"
          ? params
          : String((params as { fingerprint?: unknown })?.fingerprint ?? "");
        const signal = streamOptions.signal ?? new AbortController().signal;
        return pulser.stream(fingerprint, signal);
      }
      if (!base.stream) {
        throw new Error("Gateway transport has no stream implementation.");
      }
      const upstream = base.stream;
      return {
        async *[Symbol.asyncIterator]() {
          connection.markConnecting();
          try {
            for await (const frame of upstream(scope, params, streamOptions)) {
              connection.markOnline();
              yield frame;
            }
          } catch (cause) {
            const error = asError(cause);
            if (isAuthError(error)) {
              connection.markUnauthorized();
              options.onAuthError?.(error);
            } else {
              connection.markOffline();
            }
            throw error;
          }
        },
      };
    },
  };

  type QueryHandleInternal<T> = GatewayQueryHandle<T> & {
    fetcher: () => Promise<T>;
    read: () => T | undefined;
    set: (value: T) => { previous: T | undefined };
  };

  const collections = new Map<string, Collection<object, string | number>>();
  const queries = new Map<string, QueryHandleInternal<unknown>>();
  const streams = new Map<string, GatewayStreamHandle>();
  // Per-fingerprint invalidators, so `invalidate(prefix)` can re-pull by key.
  const invalidators = new Map<string, { key: SyncKey; run: () => void }>();

  function registerInvalidator(id: string, key: SyncKey, run: () => void) {
    invalidators.set(id, { key, run });
  }

  type KnownConfig<TRow extends object, TKey extends string | number> = {
    key: SyncKey;
    getKey: (row: TRow) => TKey;
    method?: string;
    params?: unknown;
    rows?: (payload: unknown) => Iterable<TRow>;
    stream?: GatewayCollectionConfig<TRow, TKey>["stream"];
  };

  /**
   * Build (once) a known gateway collection. Pollable lists with no upstream
   * stream get the `INVALIDATE_SCOPE` pseudo-stream wired in so `invalidate()`
   * can force a fresh RPC + reconcile.
   */
  function knownCollection<TRow extends object, TKey extends string | number>(
    def: KnownConfig<TRow, TKey>,
    gcTime: number,
  ): Collection<TRow, TKey> {
    const id = syncKeyFingerprint(def.key);
    const existing = collections.get(id);
    if (existing) return existing as unknown as Collection<TRow, TKey>;
    const pollable = def.stream === undefined;
    const config = createGatewayCollection<TRow, TKey>({
      key: def.key,
      client: transport,
      getKey: def.getKey,
      gcTime,
      startSync: false,
      ...(def.method ? { method: def.method } : {}),
      ...(def.params === undefined ? {} : { params: def.params }),
      ...(def.rows ? { rows: def.rows } : {}),
      ...(def.stream
        ? { stream: def.stream }
        : {
            stream: {
              scope: INVALIDATE_SCOPE,
              params: { fingerprint: id },
              refetchOnFrame: true,
              refetchMode: "replace" as const,
              reconnectOnGracefulEnd: false,
            },
          }),
    });
    // Persist ONLY the pollable list collections (runs/approvals/crons/memory/
    // scores/tickets/prompts/workflows). Per-run streamed collections are
    // ephemeral (`gcTime: 0`) and re-stream on demand, so caching them would just
    // surface stale per-run state on reload.
    const persistedConfig =
      persistenceStore && pollable ? withPersistence(config, persistenceStore) : config;
    const collection = createCollection<TRow, TKey>(persistedConfig);
    collections.set(id, collection as unknown as Collection<object, string | number>);
    if (pollable) {
      registerInvalidator(id, def.key, () => pulser.pulse(id));
    }
    return collection;
  }

  function queryHandle<T>(key: SyncKey, fetcher: () => Promise<T>): GatewayQueryHandle<T> {
    const id = syncKeyFingerprint(key);
    const existing = queries.get(id) as QueryHandleInternal<T> | undefined;
    if (existing) {
      // Pin the latest fetcher closure so refetch/invalidate use current params.
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
    registerInvalidator(id, key, () => void runFetch());
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
      for (const { key, run } of invalidators.values()) {
        if (syncKeyMatches(key, prefix)) run();
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
    crons: (params: CronListRequest = {}) =>
      knownCollection<GatewayCronRow, string>(gatewayCollectionDefs.crons(params), listGcTime),
    memoryFacts: (params: ListMemoryFactsRequest = {}) =>
      knownCollection<GatewayMemoryFactRow, string>(gatewayCollectionDefs.memoryFacts(params), listGcTime),
    prompts: (params: ListPromptsRequest = {}) =>
      knownCollection<GatewayPromptRow, string>(gatewayCollectionDefs.prompts(params), listGcTime),
    scores: (params: ListScoresRequest = { runId: "" }) =>
      knownCollection<GatewayScoreRow, string>(gatewayCollectionDefs.scores(params), listGcTime),
    tickets: (params: ListTicketsRequest = {}) =>
      knownCollection<GatewayTicketRow, string>(gatewayCollectionDefs.tickets(params), listGcTime),
    nodes: (runId: string) =>
      knownCollection<GatewayRunNode, string>(gatewayCollectionDefs.nodes(runId), RUN_GC_TIME),
    runEvents: (runId: string) =>
      knownCollection<GatewayRunEventRow, number>(gatewayCollectionDefs.runEvents(runId), RUN_GC_TIME),

    query: queryHandle,
    stream: streamHandle,

    getQueryData: <T,>(key: SyncKey): T | undefined => {
      const handle = queries.get(syncKeyFingerprint(key)) as QueryHandleInternal<T> | undefined;
      return handle?.read();
    },
    setQueryData: <T,>(key: SyncKey, value: T): { previous: T | undefined } => {
      const handle = queries.get(syncKeyFingerprint(key)) as QueryHandleInternal<T> | undefined;
      return handle ? handle.set(value) : { previous: undefined };
    },

    connection: connection.get,
    subscribeConnection: connection.subscribe,

    connect: async () => {
      // A lightweight probe; the instrumented transport flips the observer to
      // online / offline / unauthorized off the result. Errors are swallowed —
      // the status is the signal, not a throw.
      await transport.rpc("listRuns", {}).catch(() => undefined);
    },

    reset: () => {
      for (const collection of collections.values()) void collection.cleanup();
      for (const handle of queries.values()) void handle.collection.cleanup();
      for (const handle of streams.values()) void handle.collection.cleanup();
      collections.clear();
      queries.clear();
      streams.clear();
      invalidators.clear();
      // Drop the persisted cache too: a sign-out / remote-mode swap must not let
      // the next session hydrate the prior account's rows from disk.
      persistenceStore?.clearAll();
      connection.reset();
    },
  };
}
