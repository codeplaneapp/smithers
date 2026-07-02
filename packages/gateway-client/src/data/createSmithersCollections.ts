import {
  createCollection,
  type Collection,
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
import { smithersCollectionKeys } from "./smithersCollectionKeys.ts";
import { smithersElectricCollectionOptions } from "./smithersElectricCollectionOptions.ts";
import { smithersLocalCollectionOptions } from "./smithersLocalCollectionOptions.ts";

type AnyCollection = Collection<Record<string, unknown>, string | number>;
type QueryKey = readonly unknown[];
type MutationHandlers<TRow extends object, TKey extends string | number> = {
  onInsert?: (params: { transaction: { mutations: Array<{ key: TKey; modified: TRow; original?: TRow }> } }) => Promise<unknown>;
  onUpdate?: (params: { transaction: { mutations: Array<{ key: TKey; modified: TRow; original: TRow; changes?: Partial<TRow> }> } }) => Promise<unknown>;
  onDelete?: (params: { transaction: { mutations: Array<{ key: TKey; original: TRow }> } }) => Promise<unknown>;
};

function isClient(value: SmithersDataClient | WorkspaceMode): value is SmithersDataClient {
  return "api" in value;
}

function cacheKey(key: QueryKey) {
  return JSON.stringify(key);
}

function invalidatePrefix(queryClient: QueryClient, key: QueryKey) {
  return queryClient.invalidateQueries({ queryKey: [...key] });
}

function invalidationPrefixes(name: string): QueryKey[] {
  switch (name) {
    case "runs":
      return [["smithers", "runs"]];
    case "events":
      return [["smithers", "events"], ["smithers", "runTree"], ["smithers", "runs"]];
    case "approvals":
      return [["smithers", "approvals"]];
    case "workflows":
      return [["smithers", "workflows"]];
    case "docs":
      return [["smithers", "docs"]];
    case "prompts":
      return [["smithers", "prompts"]];
    case "scores":
      return [["smithers", "scores"]];
    case "tickets":
      return [["smithers", "tickets"]];
    case "memoryFacts":
    case "memory_facts":
      return [["smithers", "memoryFacts"]];
    case "crons":
      return [["smithers", "crons"]];
    case "nodes":
    case "runTree":
      return [["smithers", "runTree"]];
    default:
      return [["smithers"]];
  }
}

function resultKey(row: GatewayRunEventRow) {
  return `${row.runId}:${row.seq}`;
}

function q(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function runWhere(runId: string): string {
  return `run_id = ${q(runId)}`;
}

function kindWhere(kind: string | undefined): string | undefined {
  return kind ? `kind = ${q(kind)}` : undefined;
}

function txidMatch(result: { txid?: string } | undefined) {
  if (!result?.txid) throw new Error("Postgres domain API mutation did not return txid for Electric matching.");
  const txid = Number(result.txid);
  if (!Number.isInteger(txid)) throw new Error(`Invalid Postgres txid: ${result.txid}`);
  return { txid, timeout: 10_000 };
}

export function createSmithersCollections(
  clientOrMode: SmithersDataClient | WorkspaceMode,
  queryClient: QueryClient,
): SmithersCollections {
  const client = isClient(clientOrMode)
    ? clientOrMode
    : createSmithersDataClient({ mode: clientOrMode });
  const multiplayerMode = client.mode.kind === "multiplayer" ? client.mode : null;

  const collections = new Map<string, AnyCollection>();
  const getOrCreateQuery = <TRow extends object, TKey extends string | number>(
    queryKey: QueryKey,
    getKey: (row: TRow) => TKey,
    queryFn: () => Promise<TRow[]>,
    mutationHandlers: MutationHandlers<TRow, TKey> = {},
  ) => {
    const id = cacheKey(queryKey);
    const existing = collections.get(id);
    if (existing) return existing as unknown as Collection<TRow, TKey>;
    const collection = createCollection(
      smithersLocalCollectionOptions<TRow, QueryKey, TKey>({
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
      }),
    ) as unknown as Collection<TRow, TKey>;
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
  ) => {
    if (!multiplayerMode) throw new Error("Electric collections require multiplayer mode.");
    const id = cacheKey(queryKey);
    const existing = collections.get(id);
    if (existing) return existing as unknown as Collection<TRow, TKey>;
    const collection = createCollection(
      smithersElectricCollectionOptions<TRow, TKey>({
        ...(mutationHandlers as MutationHandlers<TRow, TKey>),
        id,
        mode: multiplayerMode,
        shape,
        where,
        getKey,
        mapRow,
      }),
    ) as unknown as Collection<TRow, TKey>;
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
  ) => multiplayerMode
    ? getOrCreateElectric(queryKey, shape, getKey, mapRow, where, mutationHandlers)
    : getOrCreateQuery(queryKey, getKey, queryFn, mutationHandlers);

  const invalidate = async (names?: readonly string[]) => {
    if (!names || names.length === 0) {
      await invalidatePrefix(queryClient, smithersCollectionKeys.all);
      return;
    }
    const seen = new Set<string>();
    for (const name of names) {
      for (const prefix of invalidationPrefixes(name)) {
        const id = cacheKey(prefix);
        if (seen.has(id)) continue;
        seen.add(id);
        await invalidatePrefix(queryClient, prefix);
      }
    }
  };

  let unsubscribe: (() => void) | undefined;
  const connect = () => {
    if (unsubscribe) return;
    unsubscribe = client.stream.subscribe((event) => {
      if (event.type === "reset") {
        void invalidate();
        return;
      }
      if (event.type === "change") void invalidate(event.collections);
    });
  };

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
    runTree: (runId: string) =>
      getOrCreate<GatewayRunNode, string>(
        smithersCollectionKeys.runTree(runId),
        "nodes",
        (row) => runNodeKey(row),
        () => runId ? client.api.getRunTree({ runId }) : Promise.resolve([]),
        (row) => mapSmithersElectricRow("nodes", row),
        runId ? runWhere(runId) : undefined,
      ),
    events: (runId: string, maxRows = 1_024) =>
      getOrCreate<GatewayRunEventRow, string>(
        smithersCollectionKeys.events(runId, maxRows),
        "events",
        resultKey,
        () => runId ? client.api.listRunEvents({ runId, limit: Math.min(Math.max(1, maxRows), 1_024) }) : Promise.resolve([]),
        (row) => mapSmithersElectricRow("events", row),
        runId ? runWhere(runId) : undefined,
      ),
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
        params.namespace ? `namespace = ${q(params.namespace)}` : undefined,
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
    nodes: (runId: string) => getOrCreate<GatewayRunNode, string>(
      smithersCollectionKeys.runTree(runId),
      "nodes",
      (row) => runNodeKey(row),
      () => runId ? client.api.getRunTree({ runId }) : Promise.resolve([]),
      (row) => mapSmithersElectricRow("nodes", row),
      runId ? runWhere(runId) : undefined,
    ),
    runEvents: (runId: string, maxRows = 1_024) => getOrCreate<GatewayRunEventRow, string>(
      smithersCollectionKeys.events(runId, maxRows),
      "events",
      resultKey,
      () => runId ? client.api.listRunEvents({ runId, limit: Math.min(Math.max(1, maxRows), 1_024) }) : Promise.resolve([]),
      (row) => mapSmithersElectricRow("events", row),
      runId ? runWhere(runId) : undefined,
    ),
    invalidate,
    connect,
    close() {
      unsubscribe?.();
      unsubscribe = undefined;
      collections.clear();
      if (!isClient(clientOrMode)) client.close();
    },
  };
}

type SubmitApprovalDecision = SubmitApprovalRequest["decision"];
