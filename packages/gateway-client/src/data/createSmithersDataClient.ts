import type {
  CancelRunResponse,
  CreateTicketRequest,
  CronCreateRequest,
  CronDeleteRequest,
  CronListRequest,
  CronRunRequest,
  DeleteTicketRequest,
  GetSchemaSignatureResponse,
  HijackRunResponse,
  LaunchRunResponse,
  ListApprovalsRequest,
  ListApprovalsResponse,
  ListDocsRequest,
  ListDocsResponse,
  ListRunsRequest,
  ListWorkflowsResponse,
  ResumeRunResponse,
  ListScoresRequest,
  ListTicketsRequest,
  ListWorkflowsRequest,
  SubmitApprovalResponse,
  SubmitApprovalRequest,
  UpdateTicketRequest,
} from "@smithers-orchestrator/gateway/rpc";
import { GatewayRpcError } from "../GatewayRpcError.ts";
import { flattenGatewayRunNode } from "../sync/flattenGatewayRunNode.ts";
import { runNodeKey } from "../sync/GatewayRunNode.ts";
import { snapshotToGatewayRunNode, type DevToolsSnapshot } from "../sync/snapshotToGatewayRunNode.ts";
import type { CreateSmithersDataClientOptions } from "./CreateSmithersDataClientOptions.ts";
import type { SmithersDataClient } from "./SmithersDataClient.ts";
import type { SmithersStreamEvent } from "./SmithersStreamEvent.ts";
import { normalizeGatewayRunEventRow } from "./normalizeGatewayRunEventRow.ts";

type Status = ReturnType<SmithersDataClient["stream"]["status"]>;
type EventSourceLike = {
  onopen: ((event: Event) => void) | null;
  onerror: ((event: Event) => void) | null;
  addEventListener(type: string, listener: (event: MessageEvent) => void): void;
  close(): void;
};

const unavailableFetch = (() => Promise.reject(new Error("fetch is not available in this environment."))) as unknown as typeof fetch;

function normalizeBaseUrl(baseUrl: string) {
  return baseUrl.replace(/\/+$/, "");
}

function headers(token: string | undefined, json = false) {
  const next = new Headers();
  if (json) next.set("content-type", "application/json");
  if (token) next.set("authorization", `Bearer ${token}`);
  return next;
}

function append(search: URLSearchParams, key: string, value: unknown) {
  if (value === undefined || value === null || value === "") return;
  search.set(key, String(value));
}

function listRunsSearch(params: ListRunsRequest = {}) {
  const search = new URLSearchParams();
  append(search, "status", params.filter?.status);
  append(search, "limit", params.filter?.limit);
  return search;
}

function listWorkflowsSearch(params: ListWorkflowsRequest = {}) {
  const search = new URLSearchParams();
  append(search, "hasUi", params.filter?.hasUi);
  return search;
}

function listApprovalsSearch(params: ListApprovalsRequest = {}) {
  const search = new URLSearchParams();
  append(search, "runId", params.filter?.runId);
  append(search, "workflow", params.filter?.workflow);
  append(search, "limit", params.filter?.limit);
  return search;
}

function listDocsSearch(params: ListDocsRequest = {}) {
  const search = new URLSearchParams();
  append(search, "kind", params.filter?.kind);
  append(search, "includeDeleted", params.filter?.includeDeleted);
  append(search, "updatedAfterMs", params.filter?.updatedAfterMs);
  append(search, "limit", params.filter?.limit);
  return search;
}

function cronListSearch(params: CronListRequest = {}) {
  const search = new URLSearchParams();
  append(search, "workflow", params.filter?.workflow);
  return search;
}

function listScoresSearch(params: ListScoresRequest = { runId: "" }) {
  const search = new URLSearchParams();
  append(search, "runId", params.runId);
  append(search, "nodeId", params.nodeId);
  return search;
}

function listTicketsSearch(params: ListTicketsRequest = {}) {
  const search = new URLSearchParams();
  append(search, "kind", params.kind);
  return search;
}

function withSearch(path: string, search: URLSearchParams) {
  const query = search.toString();
  return query ? `${path}?${query}` : path;
}

function approvalId(params: SubmitApprovalRequest & { approvalId?: string }) {
  return params.approvalId ?? `${params.runId}:${params.nodeId}:${params.iteration ?? 0}`;
}

function eventFromMessage(type: "change" | "reset" | "heartbeat", raw: string): SmithersStreamEvent | undefined {
  const parsed = JSON.parse(raw) as { seq?: unknown; collections?: unknown };
  const seq = typeof parsed.seq === "number" ? parsed.seq : 0;
  if (type === "change") {
    return {
      type,
      seq,
      collections: Array.isArray(parsed.collections)
        ? parsed.collections.filter((entry): entry is string => typeof entry === "string")
        : [],
    };
  }
  return { type, seq };
}

function fetchEventSource(
  url: string,
  init: { fetchImpl: typeof fetch; token?: string },
): EventSourceLike {
  const listeners = new Map<string, Set<(event: MessageEvent) => void>>();
  const abort = new AbortController();
  const source: EventSourceLike = {
    onopen: null,
    onerror: null,
    addEventListener(type, listener) {
      const set = listeners.get(type) ?? new Set();
      set.add(listener);
      listeners.set(type, set);
    },
    close() {
      abort.abort();
    },
  };
  const dispatch = (type: string, data: string) => {
    const event = new MessageEvent(type, { data });
    for (const listener of listeners.get(type) ?? []) listener(event);
  };
  void (async () => {
    try {
      const response = await init.fetchImpl(url, {
        headers: headers(init.token),
        signal: abort.signal,
      });
      if (!response.ok || !response.body) {
        source.onerror?.(new Event("error"));
        return;
      }
      source.onopen?.(new Event("open"));
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (!abort.signal.aborted) {
        const read = await reader.read();
        if (read.done) break;
        buffer += decoder.decode(read.value, { stream: true });
        const parts = buffer.split("\n\n");
        buffer = parts.pop() ?? "";
        for (const part of parts) {
          const lines = part.split("\n");
          const type = lines.find((line) => line.startsWith("event: "))?.slice(7) ?? "message";
          const data = lines.find((line) => line.startsWith("data: "))?.slice(6) ?? "{}";
          dispatch(type, data);
        }
      }
      if (!abort.signal.aborted) source.onerror?.(new Event("error"));
    } catch {
      if (!abort.signal.aborted) source.onerror?.(new Event("error"));
    }
  })();
  return source;
}

export function createSmithersDataClient(options: CreateSmithersDataClientOptions): SmithersDataClient {
  const mode = options.mode;
  const apiBaseUrl = normalizeBaseUrl(mode.apiBaseUrl);
  const fetchImpl = options.fetch ?? (typeof globalThis.fetch === "function" ? globalThis.fetch.bind(globalThis) : unavailableFetch);
  let closed = false;
  let source: EventSourceLike | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectAttempt = 0;
  let lastSeq = 0;
  let state: Status = { status: "idle" };
  const streamListeners = new Set<(event: SmithersStreamEvent) => void>();
  const statusListeners = new Set<() => void>();
  const waiters = new Set<{
    seq: number;
    resolve: () => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  const setStatus = (next: Status) => {
    if (next.status === state.status && next.reconnectingSince === state.reconnectingSince) return;
    state = next;
    for (const listener of statusListeners) listener();
  };
  const resolveWaiters = () => {
    for (const waiter of [...waiters]) {
      if (lastSeq >= waiter.seq) {
        waiters.delete(waiter);
        clearTimeout(waiter.timer);
        waiter.resolve();
      }
    }
  };
  const emit = (event: SmithersStreamEvent) => {
    lastSeq = Math.max(lastSeq, event.seq);
    resolveWaiters();
    for (const listener of streamListeners) listener(event);
  };
  const openStream = () => {
    if (closed || source || (streamListeners.size === 0 && waiters.size === 0)) return;
    setStatus(state.status === "offline" ? state : { status: "connecting" });
    const url = new URL("/v1/api/stream", apiBaseUrl);
    if (lastSeq > 0) url.searchParams.set("lastEventId", String(lastSeq));
    const EventSourceImpl = options.EventSource;
    source = EventSourceImpl
      ? new EventSourceImpl(url.toString(), { withCredentials: true, headers: Object.fromEntries(headers(mode.token)) } as EventSourceInit) as EventSourceLike
      : fetchEventSource(url.toString(), { fetchImpl, token: mode.token });
    const wasReconnect = reconnectAttempt > 0;
    source.onopen = () => {
      setStatus({ status: "online" });
      if (wasReconnect) emit({ type: "reset", seq: lastSeq });
      reconnectAttempt = 0;
    };
    source.onerror = () => {
      source?.close();
      source = null;
      if (closed || (streamListeners.size === 0 && waiters.size === 0)) return;
      const reconnectingSince = state.reconnectingSince ?? Date.now();
      setStatus({ status: "offline", reconnectingSince });
      const backoff = Math.min(10_000, 250 * 2 ** reconnectAttempt) + Math.floor(Math.random() * 100);
      reconnectAttempt += 1;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        openStream();
      }, backoff);
    };
    for (const type of ["change", "reset", "heartbeat"] as const) {
      source.addEventListener(type, (message) => {
        try {
          const event = eventFromMessage(type, String(message.data));
          if (event) emit(event);
        } catch {
          // Ignore malformed stream frames; the next heartbeat or change will resync status.
        }
      });
    }
  };

  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetchImpl(`${apiBaseUrl}${path}`, {
      method,
      headers: headers(mode.token, body !== undefined),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await response.json().catch(() => undefined) as { ok?: boolean; data?: T; error?: { code?: string; message?: string; requiredScope?: string }; seq?: number; txid?: string } | undefined;
    if (!json?.ok) {
      if (response.status === 401 || response.status === 403) setStatus({ status: "unauthorized" });
      throw new GatewayRpcError({
        method: path,
        status: response.status,
        code: json?.error?.code ?? "HTTP_ERROR",
        message: json?.error?.message ?? `Gateway HTTP ${response.status}`,
        requiredScope: json?.error?.requiredScope,
      });
    }
    return json.data as T;
  }

  async function mutate<T>(method: string, path: string, body?: unknown) {
    const response = await fetchImpl(`${apiBaseUrl}${path}`, {
      method,
      headers: headers(mode.token, true),
      body: JSON.stringify(body ?? {}),
    });
    const json = await response.json().catch(() => undefined) as { ok?: boolean; data?: T; error?: { code?: string; message?: string; requiredScope?: string }; seq?: number; txid?: string } | undefined;
    if (!json?.ok) {
      if (response.status === 401 || response.status === 403) setStatus({ status: "unauthorized" });
      throw new GatewayRpcError({
        method: path,
        status: response.status,
        code: json?.error?.code ?? "HTTP_ERROR",
        message: json?.error?.message ?? `Gateway HTTP ${response.status}`,
        requiredScope: json?.error?.requiredScope,
      });
    }
    if (typeof json.seq === "number") await client.stream.waitForSeq(json.seq).catch(() => undefined);
    return {
      data: json.data as T,
      ...(typeof json.seq === "number" ? { seq: json.seq } : {}),
      ...(typeof json.txid === "string" ? { txid: json.txid } : {}),
    };
  }

  const client: SmithersDataClient = {
    mode,
    api: {
      listRuns: (params = {}) => request("GET", withSearch("/v1/api/runs", listRunsSearch(params))),
      getRun: (params) => request("GET", `/v1/api/runs/${encodeURIComponent(params.runId)}`),
      launchRun: (params) => mutate<LaunchRunResponse>("POST", "/v1/api/runs", params),
      resumeRun: (params) => mutate<ResumeRunResponse>("POST", `/v1/api/runs/${encodeURIComponent(params.runId)}/resume`, params),
      cancelRun: (params) => mutate<CancelRunResponse>("POST", `/v1/api/runs/${encodeURIComponent(params.runId)}/cancel`, params),
      hijackRun: (params) => mutate<HijackRunResponse>("POST", `/v1/api/runs/${encodeURIComponent(params.runId)}/hijack`, params),
      rewindRun: (params) => mutate<Record<string, unknown>>("POST", `/v1/api/runs/${encodeURIComponent(params.runId)}/rewind`, params),
      listRunEvents: async (params) => {
        const search = new URLSearchParams();
        append(search, "runId", params.runId);
        append(search, "afterSeq", params.afterSeq);
        append(search, "limit", params.limit);
        const rows = await request<unknown[]>("GET", withSearch("/v1/api/events", search));
        return rows.map(normalizeGatewayRunEventRow).filter((row): row is NonNullable<typeof row> => row !== undefined);
      },
      getRunTree: async (params) => {
        const search = new URLSearchParams();
        append(search, "frameNo", params.frameNo);
        const snapshot = await request<DevToolsSnapshot>("GET", withSearch(`/v1/api/runs/${encodeURIComponent(params.runId)}/tree`, search));
        return flattenGatewayRunNode(snapshotToGatewayRunNode(snapshot)).map((row) => ({ ...row, key: runNodeKey(row) }));
      },
      getNodeOutput: (params) => {
        const search = new URLSearchParams();
        append(search, "iteration", params.iteration ?? 0);
        return request("GET", withSearch(`/v1/api/nodes/${encodeURIComponent(params.runId)}/${encodeURIComponent(params.nodeId)}/output`, search));
      },
      getNodeDiff: (params) => {
        const search = new URLSearchParams();
        append(search, "iteration", params.iteration ?? 0);
        return request("GET", withSearch(`/v1/api/nodes/${encodeURIComponent(params.runId)}/${encodeURIComponent(params.nodeId)}/diff`, search));
      },
      listApprovals: (params = {}) => request<ListApprovalsResponse>("GET", withSearch("/v1/api/approvals", listApprovalsSearch(params))),
      submitApproval: (params) => mutate<SubmitApprovalResponse>("POST", `/v1/api/approvals/${encodeURIComponent(approvalId(params))}`, params),
      submitSignal: (params) => mutate<Record<string, unknown>>("POST", "/v1/api/signals", params),
      listWorkflows: (params = {}) => request<ListWorkflowsResponse>("GET", withSearch("/v1/api/workflows", listWorkflowsSearch(params))),
      getSchemaSignature: () => request<GetSchemaSignatureResponse>("GET", "/v1/api/schema-signature"),
      cronList: (params = {}) => request("GET", withSearch("/v1/api/crons", cronListSearch(params))),
      cronCreate: (params: CronCreateRequest) => mutate("POST", "/v1/api/crons", params),
      cronDelete: (params: CronDeleteRequest) => mutate("DELETE", `/v1/api/crons/${encodeURIComponent(params.cronId)}`, params),
      cronRun: (params: CronRunRequest) => mutate<LaunchRunResponse>("POST", "/v1/api/crons/run", params),
      listDocs: (params = {}) => request<ListDocsResponse>("GET", withSearch("/v1/api/docs", listDocsSearch(params))),
      listPrompts: () => request("GET", "/v1/api/prompts"),
      listMemoryFacts: (params = {}) => {
        const search = new URLSearchParams();
        append(search, "namespace", params.namespace);
        return request("GET", withSearch("/v1/api/memory-facts", search));
      },
      listScores: (params = { runId: "" }) => params.runId ? request("GET", withSearch("/v1/api/scores", listScoresSearch(params))) : Promise.resolve([]),
      listTickets: (params = {}) => request("GET", withSearch("/v1/api/tickets", listTicketsSearch(params))),
      createTicket: (params: CreateTicketRequest) => mutate("POST", "/v1/api/tickets", params),
      updateTicket: (params: UpdateTicketRequest) => mutate("PATCH", `/v1/api/tickets/${encodeURIComponent(params.path)}`, params),
      deleteTicket: (params: DeleteTicketRequest) => mutate("DELETE", `/v1/api/tickets/${encodeURIComponent(params.path)}`, params),
    },
    stream: {
      subscribe(handler) {
        streamListeners.add(handler);
        openStream();
      return () => {
        streamListeners.delete(handler);
        if (streamListeners.size === 0 && waiters.size === 0) {
          source?.close();
          source = null;
          if (reconnectTimer) clearTimeout(reconnectTimer);
          reconnectTimer = null;
          reconnectAttempt = 0;
          setStatus({ status: "idle" });
        }
      };
      },
      subscribeStatus(handler) {
        statusListeners.add(handler);
        return () => statusListeners.delete(handler);
      },
      status: () => state,
      waitForSeq(seq) {
        if (lastSeq >= seq) return Promise.resolve();
        return new Promise((resolve, reject) => {
          const waiter = {
            seq,
            resolve: () => {
              clearTimeout(waiter.timer);
              resolve();
            },
            reject: (error: Error) => {
              clearTimeout(waiter.timer);
              reject(error);
            },
            timer: setTimeout(() => {
              waiters.delete(waiter);
              reject(new Error(`Timed out waiting for Smithers stream seq ${seq}.`));
            }, 5_000),
          };
          waiters.add(waiter);
          openStream();
        });
      },
    },
    close() {
      closed = true;
      source?.close();
      source = null;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = null;
      streamListeners.clear();
      statusListeners.clear();
      for (const waiter of waiters) waiter.resolve();
      waiters.clear();
    },
  };

  return client;
}
