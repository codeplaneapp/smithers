import {
  createCollection,
  type Collection,
  type ChangeMessageOrDeleteKeyMessage,
  type CollectionConfig,
  type DeleteMutationFn,
  type InsertMutationFn,
  type UpdateMutationFn,
} from "@tanstack/db";
import type { QueryClient } from "@tanstack/react-query";
import type {
  CronListRequest,
  ListApprovalsRequest,
  ListDocsRequest,
  ListMemoryFactsRequest,
  ListRunsRequest,
  ListScoresRequest,
  ListTicketsRequest,
  ListWorkflowsRequest,
  SubmitApprovalRequest,
} from "@smithers-orchestrator/gateway/rpc";
import type { GatewayApprovalRow } from "../sync/GatewayApprovalRow.ts";
import type { GatewayCronRow } from "../sync/GatewayCronRow.ts";
import type { GatewayMemoryFactRow } from "../sync/GatewayMemoryFactRow.ts";
import type { GatewayPromptRow } from "../sync/GatewayPromptRow.ts";
import type { GatewayRunEventRow } from "../sync/GatewayRunEventRow.ts";
import type { GatewayRunNode } from "../sync/GatewayRunNode.ts";
import { runNodeKey } from "../sync/GatewayRunNode.ts";
import type { GatewayRunRow } from "../sync/GatewayRunRow.ts";
import type { GatewayRunSummaryRow } from "../sync/GatewayRunSummaryRow.ts";
import type { GatewayScoreRow } from "../sync/GatewayScoreRow.ts";
import type { GatewayTicketRow } from "../sync/GatewayTicketRow.ts";
import type { GatewayWorkflowRow } from "../sync/GatewayWorkflowRow.ts";
import type { GatewayDocRow } from "./GatewayDocRow.ts";
import type { SmithersCollections } from "./SmithersCollections.ts";
import type { SmithersDataClient } from "./SmithersDataClient.ts";
import type { WorkspaceMode } from "./WorkspaceMode.ts";
import { createSmithersDataClient } from "./createSmithersDataClient.ts";
import { mapSmithersElectricRow } from "./mapSmithersElectricRow.ts";
import { smithersApiInvalidationPrefixes } from "./smithersApiInvalidationPrefixes.ts";
import { smithersCollectionKeys } from "./smithersCollectionKeys.ts";
import { smithersLocalCollectionOptions } from "./smithersLocalCollectionOptions.ts";

type AnyCollection = Collection<Record<string, unknown>, string | number>;
type QueryKey = readonly unknown[];
type SmithersElectricCollectionOptions = typeof import("./smithersElectricCollectionOptions.ts")["smithersElectricCollectionOptions"];
type NonSingleCollectionConfig<TRow extends object, TKey extends string | number> = CollectionConfig<TRow, TKey> & {
  schema?: never;
  singleResult?: never;
};
type MutationHandlers<TRow extends object, TKey extends string | number> = {
  onInsert?: (params: { transaction: { mutations: Array<{ key: TKey; modified: TRow; original?: TRow }> } }) => Promise<unknown>;
  onUpdate?: (params: { transaction: { mutations: Array<{ key: TKey; modified: TRow; original: TRow; changes?: Partial<TRow> }> } }) => Promise<unknown>;
  onDelete?: (params: { transaction: { mutations: Array<{ key: TKey; original: TRow }> } }) => Promise<unknown>;
};
type SubmitApprovalDecision = SubmitApprovalRequest["decision"];
const RUN_EVENT_COLLECTION_MAX_ROWS = 1_024;
const RUN_EVENT_API_FETCH_LIMIT = 10_000;
// How long an optimistic mutation waits for its txid to appear in the Electric
// shape stream before giving up.
const ELECTRIC_TXID_MATCH_TIMEOUT_MS = 10_000;

function isClient(value: SmithersDataClient | WorkspaceMode): value is SmithersDataClient {
  return "api" in value;
}

function cacheKey(key: QueryKey) {
  return JSON.stringify(key);
}

function invalidatePrefix(queryClient: QueryClient, key: QueryKey) {
  return queryClient.invalidateQueries({ queryKey: [...key] });
}

function resultKey(row: GatewayRunEventRow) {
  return `${row.runId}:${row.seq}`;
}

function runEventMaxRows(maxRows: number): number {
  return Math.min(Math.max(1, Math.floor(maxRows)), RUN_EVENT_COLLECTION_MAX_ROWS);
}

function boundedRunEventRows(rows: GatewayRunEventRow[], maxRows: number): GatewayRunEventRow[] {
  if (rows.length <= maxRows) return rows;
  return [...rows]
    .sort((left, right) => left.seq - right.seq)
    .slice(Math.max(0, rows.length - maxRows));
}

function keyFromDeleteMessage<TRow extends object, TKey extends string | number>(
  message: ChangeMessageOrDeleteKeyMessage<TRow, TKey>,
  getKey: (row: TRow) => TKey,
): TKey | undefined {
  if ("key" in message && (typeof message.key === "string" || typeof message.key === "number")) return message.key as TKey;
  if ("value" in message && message.value && typeof message.value === "object") return getKey(message.value as TRow);
  return undefined;
}

export function withBoundedRunEventSync<TRow extends GatewayRunEventRow, TKey extends string | number>(
  options: CollectionConfig<TRow, TKey>,
  maxRows: number,
): CollectionConfig<TRow, TKey> {
  const rows = new Map<TKey, TRow>();
  const evictOverflow = (write: (message: ChangeMessageOrDeleteKeyMessage<TRow, TKey>) => void) => {
    const overflow = rows.size - maxRows;
    if (overflow <= 0) return;
    const oldest = [...rows.entries()]
      .sort(([, left], [, right]) => left.seq - right.seq)
      .slice(0, overflow);
    for (const [key] of oldest) {
      rows.delete(key);
      write({ type: "delete", key });
    }
  };
  return {
    ...options,
    sync: {
      ...options.sync,
      sync(params) {
        return options.sync.sync({
          ...params,
          write(message) {
            if (message.type === "delete") {
              const key = keyFromDeleteMessage(message, options.getKey);
              if (key !== undefined) rows.delete(key);
              params.write(message);
              return;
            }
            const row = message.value as TRow;
            rows.set(options.getKey(row), row);
            params.write(message);
          },
          commit() {
            evictOverflow(params.write);
            params.commit();
          },
          truncate() {
            rows.clear();
            params.truncate();
          },
        });
      },
    },
  };
}

function quoteSqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function runWhere(runId: string): string {
  return `run_id = ${quoteSqlLiteral(runId)}`;
}

function kindWhere(kind: string | undefined): string | undefined {
  return kind ? `kind = ${quoteSqlLiteral(kind)}` : undefined;
}

function txidMatch(result: { txid?: string } | undefined) {
  if (!result?.txid) throw new Error("Postgres domain API mutation did not return txid for Electric matching.");
  const txid = Number(result.txid);
  if (!Number.isInteger(txid)) throw new Error(`Invalid Postgres txid: ${result.txid}`);
  return { txid, timeout: ELECTRIC_TXID_MATCH_TIMEOUT_MS };
}

async function loadSmithersElectricCollectionOptions(): Promise<SmithersElectricCollectionOptions> {
  const mod = await import("./smithersElectricCollectionOptions.ts");
  await mod.smithersElectricCollectionOptions.load();
  return mod.smithersElectricCollectionOptions;
}

function createSmithersCollectionsWithClient(
  client: SmithersDataClient,
  ownsClient: boolean,
  queryClient: QueryClient,
  electricCollectionOptions?: SmithersElectricCollectionOptions,
): SmithersCollections {
  const multiplayerMode = client.mode.kind === "multiplayer" ? client.mode : null;

  const collections = new Map<string, AnyCollection>();
  const getOrCreateQuery = <TRow extends object, TKey extends string | number>(
    queryKey: QueryKey,
    getKey: (row: TRow) => TKey,
    queryFn: () => Promise<TRow[]>,
    mutationHandlers: MutationHandlers<TRow, TKey> = {},
    eventMaxRows?: number,
  ) => {
    const id = cacheKey(queryKey);
    const existing = collections.get(id);
    if (existing) return existing as unknown as Collection<TRow, TKey>;
    const options = smithersLocalCollectionOptions<TRow, QueryKey, TKey>({
      id,
      queryKey,
      queryClient,
      queryFn,
      getKey,
      ...(mutationHandlers as Partial<{
        onInsert: InsertMutationFn<TRow, TKey>;
        onUpdate: UpdateMutationFn<TRow, TKey>;
        onDelete: DeleteMutationFn<TRow, TKey>;
      }>),
    });
    const collectionOptions = (
      eventMaxRows
        ? withBoundedRunEventSync(options as unknown as CollectionConfig<GatewayRunEventRow, string>, eventMaxRows)
        : options
    ) as unknown as NonSingleCollectionConfig<TRow, TKey>;
    const collection = createCollection(collectionOptions) as unknown as Collection<TRow, TKey>;
    collections.set(id, collection as unknown as AnyCollection);
    return collection;
  };
  const getOrCreateElectric = <TRow extends Record<string, unknown>, TKey extends string | number>(
    queryKey: QueryKey,
    shape: string,
    getKey: (row: TRow) => TKey,
    mapRow: (row: Record<string, unknown>) => TRow,
    where?: string,
    mutationHandlers: MutationHandlers<TRow, TKey> = {},
    eventMaxRows?: number,
  ) => {
    if (!multiplayerMode) throw new Error("Electric collections require multiplayer mode.");
    if (!electricCollectionOptions) throw new Error("Electric collection options were not loaded.");
    const id = cacheKey(queryKey);
    const existing = collections.get(id);
    if (existing) return existing as unknown as Collection<TRow, TKey>;
    const options = electricCollectionOptions<TRow, TKey>({
      ...(mutationHandlers as MutationHandlers<TRow, TKey>),
      id,
      mode: multiplayerMode,
      shape,
      where,
      getKey,
      mapRow,
    });
    const collectionOptions = (
      eventMaxRows
        ? withBoundedRunEventSync(options as unknown as CollectionConfig<GatewayRunEventRow, string>, eventMaxRows)
        : options
    ) as unknown as NonSingleCollectionConfig<TRow, TKey>;
    const collection = createCollection(collectionOptions) as unknown as Collection<TRow, TKey>;
    collections.set(id, collection as unknown as AnyCollection);
    return collection;
  };
  const getOrCreate = <TRow extends Record<string, unknown>, TKey extends string | number>(
    queryKey: QueryKey,
    shape: string,
    getKey: (row: TRow) => TKey,
    queryFn: () => Promise<TRow[]>,
    mapRow: (row: Record<string, unknown>) => TRow,
    where?: string,
    mutationHandlers: MutationHandlers<TRow, TKey> = {},
    eventMaxRows?: number,
  ) => multiplayerMode
    ? getOrCreateElectric(queryKey, shape, getKey, mapRow, where, mutationHandlers, eventMaxRows)
    : getOrCreateQuery(queryKey, getKey, queryFn, mutationHandlers, eventMaxRows);

  const invalidate = async (names?: readonly string[]) => {
    if (!names || names.length === 0) {
      await invalidatePrefix(queryClient, smithersCollectionKeys.all);
      return;
    }
    const seen = new Set<string>();
    for (const name of names) {
      for (const prefix of smithersApiInvalidationPrefixes(name)) {
        const id = cacheKey(prefix);
        if (seen.has(id)) continue;
        seen.add(id);
        await invalidatePrefix(queryClient, prefix);
      }
    }
  };

  // A busy run emits change events continuously, and refetching kilo-row
  // collections on every one saturates the tab (observed: 5 full /runs
  // re-pulls in 5 idle seconds against one 64-agent run). Coalesce change
  // invalidations leading+trailing: the first change in a quiet period
  // refetches immediately, then further changes accumulate and flush once
  // per window so the last change in a burst always lands.
  const INVALIDATE_COALESCE_MS = 2_500;
  let pendingNames: Set<string> | "all" | undefined;
  let cooldownTimer: ReturnType<typeof setTimeout> | undefined;
  const flushPending = () => {
    cooldownTimer = undefined;
    const batch = pendingNames;
    pendingNames = undefined;
    if (batch === undefined) return;
    cooldownTimer = setTimeout(flushPending, INVALIDATE_COALESCE_MS);
    void invalidate(batch === "all" ? undefined : [...batch]);
  };
  const queueInvalidate = (names?: readonly string[]) => {
    if (cooldownTimer) {
      if (!names) pendingNames = "all";
      else if (pendingNames !== "all") {
        pendingNames = pendingNames instanceof Set ? pendingNames : new Set<string>();
        for (const name of names) pendingNames.add(name);
      }
      return;
    }
    cooldownTimer = setTimeout(flushPending, INVALIDATE_COALESCE_MS);
    void invalidate(names ? [...names] : undefined);
  };

  let unsubscribe: (() => void) | undefined;
  const connect = () => {
    if (unsubscribe) return;
    unsubscribe = client.stream.subscribe((event) => {
      if (event.type === "reset") {
        // Reconnects must resync promptly; skip the coalescing window.
        void invalidate();
        return;
      }
      if (event.type === "change") queueInvalidate(event.collections);
    });
  };

  const runTreeCollection = (runId: string) =>
    getOrCreate<GatewayRunNode, string>(
      smithersCollectionKeys.runTree(runId),
      "nodes",
      (row) => runNodeKey(row),
      () => runId ? client.api.getRunTree({ runId }) : Promise.resolve([]),
      (row) => mapSmithersElectricRow("nodes", row),
      runId ? runWhere(runId) : undefined,
    );

  return {
    client,
    runs: (params: ListRunsRequest = {}) =>
      getOrCreate<GatewayRunSummaryRow, string>(
        smithersCollectionKeys.runs(params),
        "runs",
        (row) => row.runId,
        () => client.api.listRuns(params),
        (row) => mapSmithersElectricRow("runs", row),
        undefined,
        {
          onInsert: async ({ transaction }) => {
            let latest: { txid?: string } | undefined;
            for (const mutation of transaction.mutations) {
              const row = mutation.modified as GatewayRunSummaryRow & { workflow?: string; input?: Record<string, unknown> };
              const workflow = row.workflow ?? row.workflowKey;
              if (!workflow) throw new Error("runs.insert requires workflow or workflowKey.");
              latest = await client.api.launchRun({ workflow, input: row.input ?? {} });
            }
            if (multiplayerMode) return txidMatch(latest);
          },
          onUpdate: async ({ transaction }) => {
            let latest: { txid?: string } | undefined;
            for (const mutation of transaction.mutations) {
              const row = mutation.modified as GatewayRunSummaryRow;
              if (row.status === "cancelled" || row.status === "cancelling") {
                latest = await client.api.cancelRun({ runId: row.runId });
              } else if (row.status === "running") {
                latest = await client.api.resumeRun({ runId: row.runId });
              } else {
                throw new Error(`runs.update cannot persist status ${row.status ?? "unknown"}.`);
              }
            }
            if (multiplayerMode) return txidMatch(latest);
          },
          onDelete: async ({ transaction }) => {
            let latest: { txid?: string } | undefined;
            for (const mutation of transaction.mutations) {
              latest = await client.api.cancelRun({ runId: String(mutation.key) });
            }
            if (multiplayerMode) return txidMatch(latest);
          },
        },
      ),
    run: (runId: string) =>
      getOrCreate<GatewayRunRow, string>(
        smithersCollectionKeys.run(runId),
        "runs",
        (row) => row.runId,
        async () => runId ? [await client.api.getRun({ runId })] : [],
        (row) => mapSmithersElectricRow("run", row),
        runId ? runWhere(runId) : undefined,
      ),
    runTree: runTreeCollection,
    approvals: (params: ListApprovalsRequest = {}) =>
      getOrCreate<GatewayApprovalRow, string>(
        smithersCollectionKeys.approvals(params),
        "approvals",
        (row) => `${row.runId}:${row.nodeId}:${row.iteration}`,
        () => client.api.listApprovals(params),
        (row) => mapSmithersElectricRow("approvals", row),
        params.filter?.runId ? runWhere(params.filter.runId) : undefined,
        {
          onUpdate: async ({ transaction }) => {
            let latest: { txid?: string } | undefined;
            for (const mutation of transaction.mutations) {
              const row = mutation.modified as GatewayApprovalRow & { decision?: SubmitApprovalDecision };
              latest = await client.api.submitApproval({
                runId: row.runId,
                nodeId: row.nodeId,
                iteration: row.iteration,
                approved: true,
                decision: row.decision ?? { approved: true },
              });
            }
            if (multiplayerMode) return txidMatch(latest);
          },
          onDelete: async ({ transaction }) => {
            let latest: { txid?: string } | undefined;
            for (const mutation of transaction.mutations) {
              const row = mutation.original as GatewayApprovalRow;
              latest = await client.api.submitApproval({
                runId: row.runId,
                nodeId: row.nodeId,
                iteration: row.iteration,
                approved: false,
                decision: { approved: false },
              });
            }
            if (multiplayerMode) return txidMatch(latest);
          },
        },
      ),
    workflows: (params: ListWorkflowsRequest = {}) =>
      getOrCreateQuery<GatewayWorkflowRow, string>(
        smithersCollectionKeys.workflows(params),
        (row) => row.key,
        () => client.api.listWorkflows(params),
      ),
    docs: (params: ListDocsRequest = {}) =>
      getOrCreate<GatewayDocRow, string>(
        smithersCollectionKeys.docs(params),
        "docs",
        (row) => row.path,
        () => client.api.listDocs(params),
        (row) => mapSmithersElectricRow("docs", row),
        kindWhere(params.filter?.kind),
      ),
    prompts: () =>
      getOrCreateQuery<GatewayPromptRow, string>(
        smithersCollectionKeys.prompts(),
        (row) => row.entryFile,
        () => client.api.listPrompts(),
      ),
    scores: (params: ListScoresRequest = { runId: "" }) =>
      getOrCreate<GatewayScoreRow, string>(
        smithersCollectionKeys.scores(params),
        "scores",
        (row) => `${row.runId}:${row.nodeId}:${row.iteration}:${row.scorerId}`,
        () => client.api.listScores(params),
        (row) => mapSmithersElectricRow("scores", row),
        params.runId ? runWhere(params.runId) : undefined,
      ),
    tickets: (params: ListTicketsRequest = {}) =>
      getOrCreate<GatewayTicketRow, string>(
        smithersCollectionKeys.tickets(params),
        "docs",
        (row) => row.path,
        () => client.api.listTickets(params),
        (row) => mapSmithersElectricRow("tickets", row),
        kindWhere(params.kind ?? "ticket"),
      ),
    memoryFacts: (params: ListMemoryFactsRequest = {}) =>
      getOrCreate<GatewayMemoryFactRow, string>(
        smithersCollectionKeys.memoryFacts(params),
        "memory_facts",
        (row) => `${row.namespace}:${row.key}`,
        () => client.api.listMemoryFacts(params),
        (row) => mapSmithersElectricRow("memoryFacts", row),
        params.namespace ? `namespace = ${quoteSqlLiteral(params.namespace)}` : undefined,
      ),
    crons: (params: CronListRequest = {}) =>
      getOrCreate<GatewayCronRow, string>(
        smithersCollectionKeys.crons(params),
        "crons",
        (row) => row.cronId,
        () => client.api.cronList(params),
        (row) => mapSmithersElectricRow("crons", row),
        undefined,
        {
          onInsert: async ({ transaction }) => {
            let latest: { txid?: string } | undefined;
            for (const mutation of transaction.mutations) {
              const row = mutation.modified as GatewayCronRow;
              latest = await client.api.cronCreate({
                cronId: row.cronId,
                workflow: row.workflow,
                pattern: row.pattern,
                enabled: row.enabled,
              });
            }
            if (multiplayerMode) return txidMatch(latest);
          },
          onUpdate: async ({ transaction }) => {
            let latest: { txid?: string } | undefined;
            for (const mutation of transaction.mutations) {
              const row = mutation.modified as GatewayCronRow;
              latest = await client.api.cronCreate({
                cronId: row.cronId,
                workflow: row.workflow,
                pattern: row.pattern,
                enabled: row.enabled,
              });
            }
            if (multiplayerMode) return txidMatch(latest);
          },
          onDelete: async ({ transaction }) => {
            let latest: { txid?: string } | undefined;
            for (const mutation of transaction.mutations) {
              latest = await client.api.cronDelete({ cronId: String(mutation.key) });
            }
            if (multiplayerMode) return txidMatch(latest);
          },
        },
      ),
    // Deliberate alias of runTree: same cache key, same rows.
    nodes: runTreeCollection,
    runEvents: (runId: string, maxRows = RUN_EVENT_COLLECTION_MAX_ROWS) => {
      const limit = runEventMaxRows(maxRows);
      return getOrCreate<GatewayRunEventRow, string>(
        smithersCollectionKeys.events(runId, limit),
        "events",
        resultKey,
        async () => runId ? boundedRunEventRows(await client.api.listRunEvents({ runId, limit: RUN_EVENT_API_FETCH_LIMIT }), limit) : [],
        (row) => mapSmithersElectricRow("events", row),
        runId ? runWhere(runId) : undefined,
        {},
        limit,
      );
    },
    invalidate,
    connect,
    close() {
      unsubscribe?.();
      unsubscribe = undefined;
      collections.clear();
      if (ownsClient) client.close();
    },
  };
}

export function createSmithersCollections(
  clientOrMode: Extract<WorkspaceMode, { kind: "local" }>,
  queryClient: QueryClient,
): SmithersCollections;
export function createSmithersCollections(
  clientOrMode: Extract<WorkspaceMode, { kind: "multiplayer" }>,
  queryClient: QueryClient,
): Promise<SmithersCollections>;
export function createSmithersCollections(
  clientOrMode: SmithersDataClient,
  queryClient: QueryClient,
): SmithersCollections | Promise<SmithersCollections>;
export function createSmithersCollections(
  clientOrMode: SmithersDataClient | WorkspaceMode,
  queryClient: QueryClient,
  // Injectable Electric-options loader; defaults to the real dynamic import.
  // Used by tests to drive the multiplayer load-failure cleanup path without a
  // live Electric dependency. Not part of the public overloads above.
  loadElectric: () => Promise<SmithersElectricCollectionOptions> = loadSmithersElectricCollectionOptions,
): SmithersCollections | Promise<SmithersCollections> {
  const ownsClient = !isClient(clientOrMode);
  const client = ownsClient
    ? createSmithersDataClient({ mode: clientOrMode })
    : clientOrMode;
  if (client.mode.kind !== "multiplayer") {
    return createSmithersCollectionsWithClient(client, ownsClient, queryClient);
  }
  return loadElectric()
    .then((electricCollectionOptions) => createSmithersCollectionsWithClient(client, ownsClient, queryClient, electricCollectionOptions))
    .catch((error) => {
      if (ownsClient) client.close();
      throw error;
    });
}
