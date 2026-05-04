import type { GatewayRpcMethod } from "@smithers-orchestrator/gateway/rpc";
import { GatewayRpcError } from "./GatewayRpcError.ts";
import type { GatewayEventFrame } from "./GatewayEventFrame.ts";
import type { GatewayResponseFrame } from "./GatewayResponseFrame.ts";
import type { GatewayUiBootConfig } from "./GatewayUiBootConfig.ts";
import { SmithersGatewayConnection } from "./SmithersGatewayConnection.ts";
import type { SmithersGatewayClientOptions } from "./SmithersGatewayClientOptions.ts";
import type { GatewayRpcParams, GatewayRpcPayload } from "./GatewayRpcTypeMap.ts";

type StreamRunEventPayload = {
  streamId?: string;
  runId?: string;
  seq?: number;
  event?: string;
  payload?: unknown;
};

type StreamDevToolsEventPayload = {
  streamId?: string;
  runId?: string;
  event?: unknown;
  error?: unknown;
};

declare global {
  var __SMITHERS_GATEWAY_UI__: GatewayUiBootConfig | undefined;
}

function defaultBaseUrl() {
  if (typeof globalThis.location !== "undefined") {
    return globalThis.location.origin;
  }
  return "http://127.0.0.1:7331";
}

function normalizeBaseUrl(baseUrl: string) {
  return baseUrl.replace(/\/+$/, "");
}

function toWebSocketUrl(baseUrl: string, wsPath = "/") {
  const url = new URL(wsPath, baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

const unavailableFetch = (() => Promise.reject(new Error("fetch is not available in this environment."))) as unknown as typeof fetch;

function headersFromOptions(options: Pick<SmithersGatewayClientOptions, "headers" | "token">) {
  const headers = new Headers(options.headers);
  headers.set("content-type", "application/json");
  if (options.token) {
    headers.set("authorization", `Bearer ${options.token}`);
  }
  return headers;
}

function gatewayHttpError(method: string, status: number, message = `Gateway HTTP ${status}`) {
  return new GatewayRpcError({
    method,
    status,
    code: "HTTP_ERROR",
    message,
  });
}

function invalidGatewayResponse(method: string, status: number | undefined, details?: unknown) {
  return new GatewayRpcError({
    method,
    status,
    code: "INVALID_GATEWAY_RESPONSE",
    message: "Gateway returned an invalid RPC response frame.",
    details,
  });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isGatewayResponseFrame(value: unknown): value is GatewayResponseFrame {
  if (!isObject(value)) {
    return false;
  }
  if (value.type !== "res" || typeof value.id !== "string" || typeof value.ok !== "boolean") {
    return false;
  }
  if (value.ok === true) {
    return "payload" in value;
  }
  return isObject(value.error) &&
    typeof value.error.code === "string" &&
    typeof value.error.message === "string";
}

function rpcError(frame: Extract<GatewayResponseFrame, { ok: false }>, method: string, status?: number) {
  return new GatewayRpcError({
    method,
    status,
    code: frame.error.code,
    message: frame.error.message,
    requiredScope: frame.error.requiredScope,
    refresh: frame.error.refresh,
    details: frame.error.details,
  });
}

export class SmithersGatewayClient {
  readonly baseUrl: string;
  readonly token?: string;
  readonly fetchImpl: typeof fetch;
  readonly WebSocketImpl: typeof WebSocket | undefined;
  readonly headers: HeadersInit | undefined;
  readonly client: Required<NonNullable<SmithersGatewayClientOptions["client"]>>;
  readonly boot: GatewayUiBootConfig | undefined;

  constructor(options: SmithersGatewayClientOptions = {}) {
    this.boot = globalThis.__SMITHERS_GATEWAY_UI__;
    this.baseUrl = normalizeBaseUrl(options.baseUrl ?? defaultBaseUrl());
    this.token = options.token;
    this.headers = options.headers;
    this.fetchImpl = options.fetch ?? (
      typeof globalThis.fetch === "function"
        ? globalThis.fetch.bind(globalThis)
        : unavailableFetch
    );
    this.WebSocketImpl = options.WebSocket ?? globalThis.WebSocket;
    this.client = {
      id: options.client?.id ?? "smithers-gateway-client",
      version: options.client?.version ?? "0.17.0",
      platform: options.client?.platform ?? "browser",
    };
  }

  rpc<Method extends GatewayRpcMethod>(
    method: Method,
    params: GatewayRpcParams<Method>,
    options: { signal?: AbortSignal } = {},
  ): Promise<GatewayRpcPayload<Method>> {
    return this.rpcRaw(method, params, options) as Promise<GatewayRpcPayload<Method>>;
  }

  async rpcRaw(method: string, params?: unknown, options: { signal?: AbortSignal } = {}) {
    const response = await this.fetchImpl(`${this.baseUrl}/v1/rpc/${method}`, {
      method: "POST",
      headers: headersFromOptions(this),
      body: JSON.stringify(params ?? {}),
      signal: options.signal,
    });
    let frame: unknown;
    try {
      frame = await response.json();
    } catch {
      if (response.ok) {
        throw invalidGatewayResponse(method, response.status);
      }
      throw gatewayHttpError(method, response.status);
    }
    if (!isGatewayResponseFrame(frame)) {
      if (!response.ok) {
        throw gatewayHttpError(method, response.status);
      }
      throw invalidGatewayResponse(method, response.status, frame);
    }
    if (!frame.ok) {
      throw rpcError(frame, method, response.status);
    }
    return frame.payload;
  }

  async connect(options: { subscribe?: string[]; signal?: AbortSignal } = {}) {
    if (!this.WebSocketImpl) {
      throw new Error("WebSocket is not available in this environment.");
    }
    if (options.signal?.aborted) {
      throw new Error("Gateway WebSocket open aborted.");
    }
    const ws = new this.WebSocketImpl(toWebSocketUrl(this.baseUrl, this.boot?.wsPath));
    await new Promise<void>((resolve, reject) => {
      const onOpen = () => {
        cleanup();
        resolve();
      };
      const onError = () => {
        cleanup();
        reject(new Error("Gateway WebSocket failed to open."));
      };
      const onAbort = () => {
        cleanup();
        ws.close();
        reject(new Error("Gateway WebSocket open aborted."));
      };
      const cleanup = () => {
        ws.removeEventListener("open", onOpen);
        ws.removeEventListener("error", onError);
        options.signal?.removeEventListener("abort", onAbort);
      };
      ws.addEventListener("open", onOpen);
      ws.addEventListener("error", onError);
      options.signal?.addEventListener("abort", onAbort, { once: true });
    });
    const connection = new SmithersGatewayConnection(ws);
    try {
      await connection.requestRaw("connect", {
        minProtocol: 1,
        maxProtocol: 1,
        client: this.client,
        ...(this.token ? { auth: { token: this.token } } : {}),
        ...(options.subscribe ? { subscribe: options.subscribe } : {}),
      });
    } catch (error) {
      connection.close();
      throw error;
    }
    return connection;
  }

  async *streamRunEvents(
    params: GatewayRpcParams<"streamRunEvents">,
    options: { signal?: AbortSignal } = {},
  ): AsyncGenerator<GatewayEventFrame<StreamRunEventPayload>> {
    const connection = await this.connect({ subscribe: [params.runId], signal: options.signal });
    try {
      const subscribed = await connection.request("streamRunEvents", params);
      for await (const frame of connection.events(options.signal)) {
        if (
          (frame.event === "run.event" ||
            frame.event === "run.gap_resync" ||
            frame.event === "run.heartbeat" ||
            frame.event === "run.error") &&
          typeof frame.payload === "object" &&
          frame.payload !== null &&
          "streamId" in frame.payload &&
          frame.payload.streamId === subscribed.streamId
        ) {
          yield frame as GatewayEventFrame<StreamRunEventPayload>;
        }
      }
    } finally {
      connection.close();
    }
  }

  async *streamDevTools(
    params: GatewayRpcParams<"streamDevTools">,
    options: { signal?: AbortSignal } = {},
  ): AsyncGenerator<GatewayEventFrame<StreamDevToolsEventPayload>> {
    const connection = await this.connect({ subscribe: [params.runId], signal: options.signal });
    try {
      const subscribed = await connection.request("streamDevTools", params);
      if (!isObject(subscribed) || typeof subscribed.streamId !== "string") {
        throw invalidGatewayResponse("streamDevTools", undefined, subscribed);
      }
      for await (const frame of connection.events(options.signal)) {
        if (
          (frame.event === "devtools.event" || frame.event === "devtools.error") &&
          typeof frame.payload === "object" &&
          frame.payload !== null &&
          "streamId" in frame.payload &&
          frame.payload.streamId === subscribed.streamId
        ) {
          yield frame as GatewayEventFrame<StreamDevToolsEventPayload>;
        }
      }
    } finally {
      connection.close();
    }
  }

  launchRun(params: GatewayRpcParams<"launchRun">) {
    return this.rpc("launchRun", params);
  }

  resumeRun(params: GatewayRpcParams<"resumeRun">) {
    return this.rpc("resumeRun", params);
  }

  cancelRun(params: GatewayRpcParams<"cancelRun">) {
    return this.rpc("cancelRun", params);
  }

  hijackRun(params: GatewayRpcParams<"hijackRun">) {
    return this.rpc("hijackRun", params);
  }

  rewindRun(params: GatewayRpcParams<"rewindRun">) {
    return this.rpc("rewindRun", params);
  }

  submitApproval(params: GatewayRpcParams<"submitApproval">) {
    return this.rpc("submitApproval", params);
  }

  submitSignal(params: GatewayRpcParams<"submitSignal">) {
    return this.rpc("submitSignal", params);
  }

  getRun(params: GatewayRpcParams<"getRun">) {
    return this.rpc("getRun", params);
  }

  listRuns(params: GatewayRpcParams<"listRuns"> = {}) {
    return this.rpc("listRuns", params);
  }

  listWorkflows(params: GatewayRpcParams<"listWorkflows"> = {}) {
    return this.rpc("listWorkflows", params);
  }

  listApprovals(params: GatewayRpcParams<"listApprovals"> = {}) {
    return this.rpc("listApprovals", params);
  }

  getNodeOutput(params: GatewayRpcParams<"getNodeOutput">) {
    return this.rpc("getNodeOutput", params);
  }

  getNodeDiff(params: GatewayRpcParams<"getNodeDiff">) {
    return this.rpc("getNodeDiff", params);
  }

  cronList(params: GatewayRpcParams<"cronList"> = {}) {
    return this.rpc("cronList", params);
  }

  cronCreate(params: GatewayRpcParams<"cronCreate">) {
    return this.rpc("cronCreate", params);
  }

  cronDelete(params: GatewayRpcParams<"cronDelete">) {
    return this.rpc("cronDelete", params);
  }

  cronRun(params: GatewayRpcParams<"cronRun">) {
    return this.rpc("cronRun", params);
  }
}
