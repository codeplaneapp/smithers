import { createCollection, createTransaction, type Collection, type CollectionConfig } from "@tanstack/react-db";
import {
  createGatewayCollection,
  createGatewaySyncSource,
  emitSyncTelemetry,
  gatewayCollectionDefs,
  gatewayKeys,
  syncKeyFingerprint,
  syncKeyMatches,
  type CollectionDef,
  type GatewayApprovalRow,
  type GatewayDocRow,
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
  ListDocsRequest,
  ListRunsRequest,
  ListWorkflowsRequest,
} from "@smithers-orchestrator/gateway/rpc";
import type {
  GatewayCollectionStatusRow,
  GatewayCollections,
  GatewayOptimisticMutationRequest,
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
const DEFAULT_SCHEMA_VERSION = "0017";
const MUTATION_CONFIRM_TIMEOUT_MS = 30_000;
const MUTATION_CONFIRM_POLL_MS = 25;

function asError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function randomMutationId(prefix: string): string {
  const cryptoApi = globalThis.crypto;
  const suffix = typeof cryptoApi?.randomUUID === "function"
    ? cryptoApi.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${suffix}`;
}

function syncScope(scope: string): SyncKey {
  return [scope];
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
  const collectionKeys = new Map<string, SyncKey>();
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
  const sourceWithClient = source as SyncSource & {
    client?: SyncTransport;
    invalidate?: (prefix: SyncKey) => void;
    commit?: <TData>(request: { method: string; vars: unknown }) => Promise<TData>;
    confirm?: (prefix: SyncKey) => Promise<void>;
  };
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
    collectionKeys.set(id, def.key);
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

  function loadedKnownCollections(prefix: SyncKey): Array<{
    id: string;
    key: SyncKey;
    collection: Collection<object, string | number>;
  }> {
    const matches: Array<{ id: string; key: SyncKey; collection: Collection<object, string | number> }> = [];
    for (const [id, collection] of collections.entries()) {
      const key = collectionKeys.get(id);
      if (key && syncKeyMatches(key, prefix)) {
        matches.push({ id, key, collection });
      }
    }
    return matches;
  }

  function runListAccepts(key: SyncKey, row: GatewayRunSummaryRow): boolean {
    const params = asRecord(key[1]);
    const filter = asRecord(params.filter);
    const status = asString(params.status) ?? asString(filter.status);
    return !status || status === row.status;
  }

  function applyPatch(
    collection: Collection<object, string | number>,
    key: string | number,
    patch: Record<string, unknown>,
    metadata: Record<string, unknown>,
  ): void {
    collection.update(key, { metadata }, (draft) => {
      Object.assign(draft, patch);
    });
  }

  function upsertRow(
    collection: Collection<object, string | number>,
    key: string | number,
    row: Record<string, unknown>,
    metadata: Record<string, unknown>,
  ): void {
    if (collection.has(key)) {
      applyPatch(collection, key, row, metadata);
      return;
    }
    collection.insert(row, { metadata });
  }

  async function invalidatePrefix(prefix: SyncKey): Promise<void> {
    sourceWithClient.invalidate?.(prefix);
    for (const [id, query] of queries.entries()) {
      const key = queryKeyById.get(id);
      if (key && syncKeyMatches(key, prefix)) void query.refetch();
    }
  }

  type ConfirmTarget = {
    collectionId: string;
    collection: Collection<object, string | number>;
    key: string | number;
  };

  function asRows(payload: unknown): Record<string, unknown>[] {
    return Array.isArray(payload)
      ? payload.filter((row): row is Record<string, unknown> => typeof row === "object" && row !== null)
      : [];
  }

  /**
   * Poll the server of record until the write is reflected (the run appears, the
   * approval is gone, …) or the deadline passes. Runs while the optimistic
   * transaction is still `persisting`, so the confirming sync write that lands
   * afterwards is buffered and merged atomically on completion — the optimistic
   * row never blinks out. The synced state cannot be observed through the
   * collection here (the optimistic upsert masks it), so confirmation reads the
   * backend directly through the source transport.
   */
  async function waitForBackendConfirm(predicate: (transport: SyncTransport) => Promise<boolean>): Promise<void> {
    const deadline = Date.now() + MUTATION_CONFIRM_TIMEOUT_MS;
    for (;;) {
      let confirmed = false;
      try {
        confirmed = await predicate(transport);
      } catch {
        confirmed = false;
      }
      if (confirmed || Date.now() >= deadline) return;
      await new Promise((resolve) => setTimeout(resolve, MUTATION_CONFIRM_POLL_MS));
    }
  }

  /**
   * Awaitable invalidation used inside the optimistic write handler: each
   * matching collection re-pulls and applies its confirmed rows (`source.confirm`
   * resolves only once that refetch lands), and generic query handles refetch.
   * Falls back to fire-and-forget invalidation for a source without `confirm`.
   */
  async function confirmInvalidation(prefixes: readonly SyncKey[]): Promise<void> {
    for (const prefix of prefixes) {
      if (sourceWithClient.confirm) {
        await sourceWithClient.confirm(prefix);
      } else {
        sourceWithClient.invalidate?.(prefix);
      }
      for (const [id, query] of queries.entries()) {
        const key = queryKeyById.get(id);
        if (key && syncKeyMatches(key, prefix)) void query.refetch();
      }
    }
  }

  type PreparedMutation<TVars> = {
    vars: TVars;
    telemetryKey: SyncKey;
    invalidate: readonly SyncKey[];
    apply: (metadata: Record<string, unknown>) => ConfirmTarget[];
    /**
     * Resolves true once the server of record reflects the write. Absent for
     * writes with no observable confirmation (signals), which fall through to a
     * plain refetch.
     */
    confirm?: (transport: SyncTransport) => Promise<boolean>;
  };

  function prepareGatewayMutation<TVars>(method: string, vars: TVars): PreparedMutation<TVars> | undefined {
    const normalized = method === "runs.create"
      ? "launchRun"
      : method === "runs.cancel"
        ? "cancelRun"
        : method === "approvals.decide"
          ? "submitApproval"
          : method === "signals.send"
            ? "submitSignal"
            : method;
    const input = asRecord(vars);

    if (normalized === "launchRun") {
      const workflow = asString(input.workflow);
      if (!workflow) return undefined;
      const originalOptions = asRecord(input.options);
      const runId = asString(originalOptions.runId) ?? asString(input.runId) ?? randomMutationId("run");
      const row: GatewayRunSummaryRow = {
        runId,
        workflowKey: workflow,
        status: "queued",
        createdAtMs: Date.now(),
      };
      return {
        vars: {
          ...input,
          options: { ...originalOptions, runId },
        } as TVars,
        telemetryKey: gatewayKeys.runs({}),
        invalidate: [syncScope("gateway:listRuns"), gatewayKeys.run(runId)],
        apply(metadata) {
          const targets: ConfirmTarget[] = [];
          for (const entry of loadedKnownCollections(syncScope("gateway:listRuns"))) {
            if (!runListAccepts(entry.key, row)) continue;
            upsertRow(entry.collection, runId, row, metadata);
            targets.push({
              collectionId: entry.id,
              collection: entry.collection,
              key: runId,
            });
          }
          return targets;
        },
        confirm: async (client) => {
          // Confirmed once the launched run is listed by the server of record.
          const rows = asRows(await client.rpc("listRuns", {}));
          return rows.some((entry) => asString(entry.runId) === runId);
        },
      };
    }

    if (normalized === "submitApproval") {
      const runId = asString(input.runId);
      const nodeId = asString(input.nodeId);
      const iteration = typeof input.iteration === "number" ? input.iteration : 0;
      const decision = asRecord(input.decision);
      const approved = asBoolean(decision.approved) ?? asBoolean(input.approved);
      if (!runId || !nodeId || approved === undefined) return undefined;
      const approvalKey = `${runId}:${nodeId}:${iteration}`;
      return {
        vars,
        telemetryKey: gatewayKeys.approvals({}),
        invalidate: [syncScope("gateway:listApprovals"), syncScope("gateway:listRuns"), gatewayKeys.run(runId)],
        apply(metadata) {
          const targets: ConfirmTarget[] = [];
          for (const entry of loadedKnownCollections(syncScope("gateway:listApprovals"))) {
            if (!entry.collection.has(approvalKey)) continue;
            applyPatch(
              entry.collection,
              approvalKey,
              {
                status: approved ? "approved" : "denied",
                decision: input.decision,
                decidedAtMs: Date.now(),
              },
              metadata,
            );
            targets.push({
              collectionId: entry.id,
              collection: entry.collection,
              key: approvalKey,
            });
          }
          return targets;
        },
        confirm: async (client) => {
          // Confirmed once the decided gate no longer appears as pending.
          const rows = asRows(await client.rpc("listApprovals", {}));
          return !rows.some(
            (entry) =>
              asString(entry.runId) === runId &&
              asString(entry.nodeId) === nodeId &&
              (typeof entry.iteration === "number" ? entry.iteration : 0) === iteration,
          );
        },
      };
    }

    if (normalized === "cancelRun" || normalized === "submitSignal") {
      const runId = asString(input.runId);
      if (!runId) return undefined;
      const status = normalized === "cancelRun" ? "cancelling" : "running";
      return {
        vars,
        telemetryKey: gatewayKeys.run(runId),
        invalidate: [syncScope("gateway:listRuns"), gatewayKeys.run(runId)],
        apply(metadata) {
          const targets: ConfirmTarget[] = [];
          for (const entry of loadedKnownCollections(syncScope("gateway:listRuns"))) {
            if (!entry.collection.has(runId)) continue;
            applyPatch(entry.collection, runId, { status }, metadata);
            targets.push({
              collectionId: entry.id,
              collection: entry.collection,
              key: runId,
            });
          }
          for (const entry of loadedKnownCollections(gatewayKeys.run(runId))) {
            if (!entry.collection.has(runId)) continue;
            applyPatch(entry.collection, runId, { status }, metadata);
            targets.push({
              collectionId: entry.id,
              collection: entry.collection,
              key: runId,
            });
          }
          return targets;
        },
        // A cancel is confirmed once the run leaves an active state; a signal has
        // no observable list change, so it falls through to a plain refetch.
        confirm: normalized === "cancelRun"
          ? async (client) => {
              const run = asRecord(await client.rpc("getRun", { runId }));
              const runStatus = asString(run.status);
              return runStatus !== undefined && runStatus !== "running" && runStatus !== "queued" && runStatus !== "waiting";
            }
          : undefined,
      };
    }

    return undefined;
  }

  function optimisticMutation<TVars, TData>(
    request: GatewayOptimisticMutationRequest<TVars, TData>,
  ): Promise<TData> | undefined {
    const plan = prepareGatewayMutation(request.method, request.vars);
    if (!plan) return undefined;
    const mutationId = randomMutationId("gateway-mutation");
    const startedAtMs = Date.now();
    let data: TData | undefined;
    let targets: ConfirmTarget[] = [];
    const telemetryCollectionId = () => targets[0]?.collectionId ?? syncKeyFingerprint(plan.telemetryKey);

    // Route the write through the source's own commit path so a second source
    // (Electric) can swap in its write transport. The request's own commit
    // closure (gateway RPC) remains the fallback for a source without `commit`.
    const commitWrite = (vars: TVars): Promise<TData> =>
      sourceWithClient.commit
        ? sourceWithClient.commit<TData>({ method: request.method, vars })
        : request.commit(vars);

    const tx = createTransaction<object>({
      autoCommit: false,
      metadata: { method: request.method, mutationId },
      mutationFn: async () => {
        // 1. Persist to the server of record.
        const rpcStartedAtMs = Date.now();
        try {
          data = await commitWrite(plan.vars);
          emitSyncTelemetry({
            type: "sync.mutation.handler_rpc",
            collectionId: telemetryCollectionId(),
            key: plan.telemetryKey,
            method: request.method,
            mutationId,
            durationMs: Date.now() - rpcStartedAtMs,
            count: targets.length,
          });
        } catch (cause) {
          const error = asError(cause);
          emitSyncTelemetry({
            type: "sync.mutation.handler_rpc",
            collectionId: telemetryCollectionId(),
            key: plan.telemetryKey,
            method: request.method,
            mutationId,
            durationMs: Date.now() - rpcStartedAtMs,
            count: targets.length,
            error: error.message,
          });
          throw error;
        }
        // 2. Hold the optimistic transaction open until the write is confirmed.
        //    Both the backend poll and the awaited refetch run while the tx is
        //    still `persisting`, so the confirming sync write is buffered and
        //    merged atomically when the tx completes. The optimistic row stays
        //    continuously visible and `$synced` flips false → true with no gap.
        if (plan.confirm) await waitForBackendConfirm(plan.confirm);
        await confirmInvalidation(plan.invalidate);
        emitSyncTelemetry({
          type: "sync.mutation.confirm",
          collectionId: telemetryCollectionId(),
          key: plan.telemetryKey,
          method: request.method,
          mutationId,
          durationMs: Date.now() - startedAtMs,
          count: targets.length,
        });
      },
    });
    try {
      tx.mutate(() => {
        targets = plan.apply({ method: request.method, mutationId });
      });
      if (tx.mutations.length === 0 || targets.length === 0) {
        void tx.isPersisted.promise.catch(() => undefined);
        tx.rollback();
        return undefined;
      }
      emitSyncTelemetry({
        type: "sync.mutation.optimistic_apply",
        collectionId: telemetryCollectionId(),
        key: plan.telemetryKey,
        method: request.method,
        mutationId,
        count: tx.mutations.length,
      });
    } catch (cause) {
      void tx.isPersisted.promise.catch(() => undefined);
      if (tx.state === "pending" || tx.state === "persisting") tx.rollback();
      throw cause;
    }

    return tx.commit().then(
      () => data as TData,
      (cause) => {
        const error = asError(cause);
        emitSyncTelemetry({
          type: "sync.mutation.rollback",
          collectionId: telemetryCollectionId(),
          key: plan.telemetryKey,
          method: request.method,
          mutationId,
          durationMs: Date.now() - startedAtMs,
          count: tx.mutations.length,
          rollbackCount: tx.mutations.length,
          error: error.message,
        });
        throw error;
      },
    );
  }

  return {
    client: transport,
    rpc: <T,>(method: string, params: unknown, opts?: { signal?: AbortSignal }) =>
      transport.rpc(method, params, opts) as Promise<T>,

    invalidate: invalidatePrefix,
    optimisticMutation,

    runs: (params: ListRunsRequest = {}) =>
      knownCollection<GatewayRunSummaryRow, string>(gatewayCollectionDefs.runs(params), listGcTime),
    run: (runId: string) =>
      knownCollection<GatewayRunRow, string>(gatewayCollectionDefs.run(runId), RUN_GC_TIME),
    workflows: (params: ListWorkflowsRequest = {}) =>
      knownCollection<GatewayWorkflowRow, string>(gatewayCollectionDefs.workflows(params), listGcTime),
    approvals: (params: ListApprovalsRequest = {}) =>
      knownCollection<GatewayApprovalRow, string>(gatewayCollectionDefs.approvals(params), listGcTime),
    tickets: (params: ListDocsRequest = {}) =>
      knownCollection<GatewayDocRow, string>(gatewayCollectionDefs.tickets(params), listGcTime),
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
      collectionKeys.clear();
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
