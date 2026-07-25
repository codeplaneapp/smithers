import type {
  CancelRunResponse,
  ListScoresForRunsRequest,
  ListScoresForRunsResponse,
  CreateTicketRequest,
  CronCreateRequest,
  CronDeleteRequest,
  CronListRequest,
  CronRunRequest,
  DeleteTicketRequest,
  GetSchemaSignatureResponse,
  GetScoreDetailRequest,
  GetScoreDetailResponse,
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
} from "@smithers-orchestrator/protocol/gateway-rpc";
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
type StreamHttpError = Error & { status: number };

const unavailableFetch = (() => Promise.reject(new Error("fetch is not available in this environment."))) as unknown as typeof fetch;

// Capture the runtime constructor while this module is initialized. DOM test
// environments can replace the global AbortController later; passing one of
// those cross-realm signals to the native fetch implementation makes the SSE
// request fail before it reaches the gateway.
const RuntimeAbortController = globalThis.AbortController;

// Exponential backoff for the SSE change stream. Deliberately NOT
// gatewayBackoffDelay — that helper applies symmetric ±jitter, while this
// stream adds a small flat jitter on top of the capped exponential delay.
const STREAM_RECONNECT_BASE_MS = 250;
const STREAM_RECONNECT_MAX_MS = 10_000;
const STREAM_RECONNECT_JITTER_MS = 100;

// Bound on how long a mutation blocks waiting for its own change to stream back.
const WAIT_FOR_SEQ_TIMEOUT_MS = 5_000;

// The `{ ok, data | error, seq?, txid? }` envelope every `/v1/api/*` response wears.
type ApiEnvelope<T> = {
  ok?: boolean;
  data?: T;
  error?: { code?: string; message?: string; requiredScope?: string };
  seq?: number;
  txid?: string;
};

function normalizeBaseUrl(baseUrl: string) {
  return baseUrl.replace(/\/+$/, "");
}

// Custom headers come first so the gateway's own content type and bearer
// authorization always win — the same precedence SmithersGatewayClient applies
// to RPC requests.
function headers(custom: HeadersInit | undefined, token: string | undefined, json = false) {
  const next = new Headers(custom);
  if (json) next.set("content-type", "application/json");
  if (token) next.set("authorization", `Bearer ${token}`);
  return next;
}

function isUnauthorizedStatus(status: number) {
  return status === 401 || status === 403;
}

function streamHttpStatus(cause: unknown) {
  if (typeof cause !== "object" || cause === null || !("status" in cause)) return undefined;
  const status = (cause as { status?: unknown }).status;
  return typeof status === "number" ? status : undefined;
}

function append(search: URLSearchParams, key: string, value: unknown) {
  if (value === undefined || value === null || value === "") return;
  search.set(key, String(value));
}

function listRunsSearch(params: ListRunsRequest = {}) {
  const search = new URLSearchParams();
  append(search, "status", params.filter?.status);
  append(search, "workflow", params.filter?.workflow);
  append(search, "limit", params.filter?.limit);
  append(search, "offset", params.filter?.offset);
  return search;
}

function listWorkflowsSearch(params: ListWorkflowsRequest = {}) {
  const search = new URLSearchParams();
  append(search, "hasUi", params.filter?.hasUi);
  append(search, "includeSystem", params.filter?.includeSystem);
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

function listUsageReportsSearch(params: { fresh?: boolean } = {}) {
  const search = new URLSearchParams();
  append(search, "fresh", params.fresh);
  return search;
}

function listScoresSearch(params: ListScoresRequest = { runId: "" }) {
  const search = new URLSearchParams();
  append(search, "runId", params.runId);
  append(search, "nodeId", params.nodeId);
  return search;
}

function listScoresForRunsSearch(params: ListScoresForRunsRequest) {
  const search = new URLSearchParams();
  for (const runId of params.runIds) search.append("runId", runId);
  if (params.nodeId !== undefined) search.set("nodeId", params.nodeId);
  if (params.scorerId !== undefined) search.set("scorerId", params.scorerId);
  if (params.scorerName !== undefined) search.set("scorerName", params.scorerName);
  if (params.source !== undefined) search.set("source", params.source);
  if (params.order !== undefined) search.set("order", params.order);
  if (params.offset !== undefined) search.set("offset", String(params.offset));
  if (params.limit !== undefined) search.set("limit", String(params.limit));
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
  init: { fetchImpl: typeof fetch; headers?: HeadersInit; onError?: (cause: unknown) => void },
): EventSourceLike {
  const listeners = new Map<string, Set<(event: MessageEvent) => void>>();
  const abort = new RuntimeAbortController();
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
  const fail = (cause: unknown) => {
    if (abort.signal.aborted) return;
    init.onError?.(cause);
    source.onerror?.(new Event("error"));
  };
  void (async () => {
    try {
      const response = await init.fetchImpl(url, {
        headers: init.headers,
        signal: abort.signal,
      });
      if (!response.ok || !response.body) {
        fail(Object.assign(new Error(`Smithers stream request failed with HTTP ${response.status}.`), {
          status: response.status,
        }) as StreamHttpError);
        return;
      }
      // An OK response that is not an SSE stream cannot be the gateway's
      // change stream — a SPA history fallback answers 200 + text/html here.
      // Fail before onopen so the client parks in its normal offline/backoff
      // path instead of flapping online (each bogus open would emit a reset
      // and refetch every collection). Mirrors the browser EventSource, which
      // also rejects non-`text/event-stream` responses.
      const streamMediaType = (response.headers.get("content-type") ?? "").split(";", 1)[0]!.trim().toLowerCase();
      if (streamMediaType !== "text/event-stream") {
        fail(Object.assign(new Error(`Smithers stream endpoint answered with ${streamMediaType || "no content-type"} instead of text/event-stream; no gateway behind this URL.`), {
          status: response.status,
        }) as StreamHttpError);
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
        // Normalize CR/CRLF to LF per the SSE spec's line-splitting rule. A
        // trailing CR is held back in the buffer: it may be the first half of
        // a CRLF pair whose LF arrives in the next chunk.
        buffer = buffer.replace(/\r\n/g, "\n").replace(/\r(?=[\s\S])/g, "\n");
        const parts = buffer.split("\n\n");
        buffer = parts.pop() ?? "";
        for (const part of parts) {
          const lines = part.split("\n");
          let type = "message";
          const dataLines: string[] = [];
          for (const line of lines) {
            if (line === "" || line.startsWith(":")) continue;
            const colonIndex = line.indexOf(":");
            const field = colonIndex === -1 ? line : line.slice(0, colonIndex);
            const rawValue = colonIndex === -1 ? "" : line.slice(colonIndex + 1);
            const value = rawValue.startsWith(" ") ? rawValue.slice(1) : rawValue;
            if (field === "event") type = value;
            else if (field === "data") dataLines.push(value);
          }
          dispatch(type, dataLines.length > 0 ? dataLines.join("\n") : "{}");
        }
      }
      fail(new Error("Smithers stream ended before the run was done."));
    } catch (cause) {
      fail(cause);
    }
  })();
  return source;
}

export function createSmithersDataClient(options: CreateSmithersDataClientOptions): SmithersDataClient {
  const mode = options.mode;
  const apiBaseUrl = normalizeBaseUrl(mode.apiBaseUrl);
  const fetchImpl = options.fetch ?? (typeof globalThis.fetch === "function" ? globalThis.fetch.bind(globalThis) : unavailableFetch);
  // Every `/v1/api/*` request and the change stream carry the caller's custom
  // headers alongside the workspace token, so an API-key/proxy header applied to
  // RPC authorizes the collection API and SSE identically.
  const requestHeaders = (json = false) => headers(options.headers, mode.token, json);
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
    timer: ReturnType<typeof setTimeout>;
  }>();

  const setStatus = (next: Status) => {
    if (next.status === state.status && next.reconnectingSince === state.reconnectingSince) return;
    state = next;
    for (const listener of statusListeners) listener();
  };
  // Tear the stream down once nothing consumes it. A stream opened purely to
  // satisfy a waitForSeq waiter (a mutation-only client that never subscribes)
  // has no consumer left once the waiter settles, so it must be closed here or
  // it stays connected until close() — burning a gateway connection slot and a
  // reader loop for nobody.
  const closeStreamIfUnused = () => {
    if (streamListeners.size > 0 || waiters.size > 0) return;
    source?.close();
    source = null;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
    reconnectAttempt = 0;
    setStatus({ status: "idle" });
  };
  const resolveWaiters = () => {
    for (const waiter of [...waiters]) {
      if (lastSeq >= waiter.seq) {
        waiters.delete(waiter);
        clearTimeout(waiter.timer);
        waiter.resolve();
      }
    }
    closeStreamIfUnused();
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
    // The transport's own failure reason, captured so the reconnect error can
    // carry a cause instead of a bare Event.
    let streamCause: unknown;
    source = EventSourceImpl
      ? new EventSourceImpl(url.toString(), { withCredentials: true, headers: Object.fromEntries(requestHeaders()) } as EventSourceInit) as EventSourceLike
      : fetchEventSource(url.toString(), { fetchImpl, headers: requestHeaders(), onError: (cause) => { streamCause = cause; } });
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
      const status = streamHttpStatus(streamCause);
      if (status !== undefined && isUnauthorizedStatus(status)) {
        // Park instead of retrying: a rejected token keeps failing, so looping
        // just hammers the gateway. Count the drop as a reconnect attempt so
        // the recovery reopen (a later authorized REST call) emits a reset and
        // subscribers resync what they missed while parked.
        reconnectAttempt += 1;
        setStatus({ status: "unauthorized" });
        return;
      }
      const reconnectingSince = state.reconnectingSince ?? Date.now();
      setStatus({ status: "offline", reconnectingSince });
      const backoff = Math.min(STREAM_RECONNECT_MAX_MS, STREAM_RECONNECT_BASE_MS * 2 ** reconnectAttempt) +
        Math.floor(Math.random() * STREAM_RECONNECT_JITTER_MS);
      // Surface every drop so a broken stream is observable rather than
      // reconnecting silently. reconnectAttempt is the attempt about to run.
      options.onError?.({
        reason: "disconnected",
        reconnectAttempt,
        backoffMs: backoff,
        ...(streamCause === undefined ? {} : { cause: streamCause }),
      });
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
        } catch (cause) {
          // A malformed frame is dropped (the next heartbeat/change resyncs), but
          // report it so a broken stream is observable.
          options.onError?.({ reason: "malformed_frame", event: type, cause });
        }
      });
    }
  };

  // Shared `/v1/api/*` envelope handling for request/mutate: parse, flip to
  // unauthorized on 401/403, and throw the gateway's error (or an HTTP
  // fallback) when the envelope is not ok. A 2xx response whose body is not an
  // envelope at all means no gateway answered this URL (the host app's SPA
  // fallback serves index.html for `/v1/api/*` when nothing is wired); that
  // classifies as GATEWAY_UNAVAILABLE so consumers can degrade quietly
  // (isGatewayUnavailableError) instead of reporting "Gateway HTTP 200".
  const readEnvelope = async <T>(path: string, response: Response): Promise<ApiEnvelope<T>> => {
    const raw: unknown = await response.json().catch(() => undefined);
    const envelopeShaped =
      typeof raw === "object" && raw !== null && typeof (raw as { ok?: unknown }).ok === "boolean";
    const json = envelopeShaped ? (raw as ApiEnvelope<T>) : undefined;
    if (!json?.ok) {
      if (isUnauthorizedStatus(response.status)) setStatus({ status: "unauthorized" });
      if (response.ok && !envelopeShaped) {
        throw new GatewayRpcError({
          method: path,
          status: response.status,
          code: "GATEWAY_UNAVAILABLE",
          message:
            "The response is not a Smithers gateway envelope; this URL is likely served by an app's HTML fallback because no gateway is wired.",
        });
      }
      throw new GatewayRpcError({
        method: path,
        status: response.status,
        code: json?.error?.code ?? "HTTP_ERROR",
        message: json?.error?.message ?? `Gateway HTTP ${response.status}`,
        requiredScope: json?.error?.requiredScope,
      });
    }
    // A successful envelope proves the token is accepted again; un-park a
    // stream that gave up after an unauthorized failure (no-op while a source
    // is live or nobody is subscribed).
    if (state.status === "unauthorized") openStream();
    return json;
  };

  // A fetch-level rejection (connection refused, DNS failure, no fetch in this
  // environment) means nothing is listening at all — the dead-endpoint twin of
  // readEnvelope's SPA-fallback case — so it classifies as GATEWAY_UNAVAILABLE
  // too and consumers degrade quietly. Any actual Response, ok or not, passes
  // through to readEnvelope, which keeps real gateway and HTTP errors loud.
  const fetchGateway = async (path: string, init: RequestInit): Promise<Response> => {
    try {
      return await fetchImpl(`${apiBaseUrl}${path}`, init);
    } catch (cause) {
      throw new GatewayRpcError({
        method: path,
        code: "GATEWAY_UNAVAILABLE",
        message: `No Smithers gateway reachable at ${apiBaseUrl}: ${cause instanceof Error ? cause.message : String(cause)}`,
      });
    }
  };

  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetchGateway(path, {
      method,
      headers: requestHeaders(body !== undefined),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await readEnvelope<T>(path, response);
    return json.data as T;
  }

  async function mutate<T>(method: string, path: string, body?: unknown) {
    const response = await fetchGateway(path, {
      method,
      headers: requestHeaders(true),
      body: JSON.stringify(body ?? {}),
    });
    const json = await readEnvelope<T>(path, response);
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
      listRunTokenUsage: (params) => request("GET", `/v1/api/runs/${encodeURIComponent(params.runId)}/token-usage`),
      launchRun: (params) => mutate<LaunchRunResponse>("POST", "/v1/api/runs", params),
      resumeRun: (params) => mutate<ResumeRunResponse>("POST", `/v1/api/runs/${encodeURIComponent(params.runId)}/resume`, params),
      cancelRun: (params) => mutate<CancelRunResponse>("POST", `/v1/api/runs/${encodeURIComponent(params.runId)}/cancel`, params),
      hijackRun: (params) => mutate<HijackRunResponse>("POST", `/v1/api/runs/${encodeURIComponent(params.runId)}/hijack`, params),
      rewindRun: (params) => mutate<Record<string, unknown>>("POST", `/v1/api/runs/${encodeURIComponent(params.runId)}/rewind`, params),
      listRunEvents: async (params) => {
        const search = new URLSearchParams();
        append(search, "runId", params.runId);
        append(search, "nodeId", params.nodeId);
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
      listUsageReports: (params = {}) => request("GET", withSearch("/v1/api/usage", listUsageReportsSearch(params))),
      listDocs: (params = {}) => request<ListDocsResponse>("GET", withSearch("/v1/api/docs", listDocsSearch(params))),
      listPrompts: () => request("GET", "/v1/api/prompts"),
      listMemoryFacts: (params = {}) => {
        const search = new URLSearchParams();
        append(search, "namespace", params.namespace);
        return request("GET", withSearch("/v1/api/memory-facts", search));
      },
      listScores: (params = { runId: "" }) => params.runId ? request("GET", withSearch("/v1/api/scores", listScoresSearch(params))) : Promise.resolve([]),
      listScoresForRuns: (params: ListScoresForRunsRequest) => request<ListScoresForRunsResponse>(
        "GET",
        withSearch("/v1/api/scores/compare", listScoresForRunsSearch(params)),
      ),
      getScoreDetail: (params: GetScoreDetailRequest) => request<GetScoreDetailResponse>(
        "GET",
        `/v1/api/scores/${encodeURIComponent(params.runId)}/${encodeURIComponent(params.scoreId)}`,
      ),
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
          closeStreamIfUnused();
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
            timer: setTimeout(() => {
              waiters.delete(waiter);
              closeStreamIfUnused();
              reject(new Error(`Timed out waiting for Smithers stream seq ${seq}.`));
            }, WAIT_FOR_SEQ_TIMEOUT_MS),
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
