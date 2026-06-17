import type { GatewayRpcMethod } from "@smithers-orchestrator/gateway/rpc";
import { GatewayRpcError } from "./GatewayRpcError.ts";
import type { GatewayEventFrame } from "./GatewayEventFrame.ts";
import type { GatewayResponseFrame } from "./GatewayResponseFrame.ts";
import type { GatewayUiBootConfig } from "./GatewayUiBootConfig.ts";
import { gatewayBackoffDelay, type GatewayBackoffOptions } from "./gatewayBackoffDelay.ts";
import { SmithersGatewayConnection } from "./SmithersGatewayConnection.ts";
import type { SmithersGatewayClientOptions } from "./SmithersGatewayClientOptions.ts";
import type { GatewayRpcParams, GatewayRpcPayload } from "./GatewayRpcTypeMap.ts";
import {
  GATEWAY_EXTENSION_STREAM_ERROR,
  GATEWAY_EXTENSION_STREAM_EVENT,
  extensionMethodName,
  extensionStreamMethodName,
  type GatewayExtensionStreamErrorFrame,
  type GatewayExtensionStreamFrame,
  type GatewayExtensionSubscribeResponse,
} from "./GatewayExtensionEnvelope.ts";

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

export type GatewayStreamReconnectEvent = {
  runId: string;
  afterSeq?: number;
  attempt: number;
  backoffMs: number;
  reason: "stream_closed" | "transport_error";
  error?: unknown;
};

type StreamRunEventsResilientOptions = {
  signal?: AbortSignal;
  backoff?: GatewayBackoffOptions;
  healthyAfterMs?: number;
  onReconnect?: (event: GatewayStreamReconnectEvent) => void;
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

function isUnixWebSocketUrl(baseUrl: string) {
  return /^ws\+unix:/i.test(baseUrl);
}

function normalizeBaseUrl(baseUrl: string) {
  if (isUnixWebSocketUrl(baseUrl)) {
    return baseUrl;
  }
  return baseUrl.replace(/\/+$/, "");
}

function toWebSocketUrl(baseUrl: string, wsPath = "/") {
  if (isUnixWebSocketUrl(baseUrl)) {
    const url = new URL(baseUrl);
    const socketPath = url.pathname.split(":", 1)[0];
    const path = wsPath.startsWith("/") ? wsPath : `/${wsPath}`;
    url.pathname = `${socketPath}:${path}`;
    url.search = "";
    return url.toString();
  }
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

function sleepWithSignal(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function raceSignal<T>(promise: Promise<T>, signal: AbortSignal | undefined, message: string): Promise<T> {
  if (!signal) {
    return promise;
  }
  if (signal.aborted) {
    return Promise.reject(new Error(message));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(new Error(message));
    };
    const cleanup = () => {
      signal.removeEventListener("abort", onAbort);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
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
        ws.close();
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
      await raceSignal(
        connection.requestRaw("connect", {
          minProtocol: 1,
          maxProtocol: 1,
          client: this.client,
          ...(this.token ? { auth: { token: this.token } } : {}),
          ...(options.subscribe ? { subscribe: options.subscribe } : {}),
        }),
        options.signal,
        "Gateway WebSocket open aborted.",
      );
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
      if (!isObject(subscribed) || typeof subscribed.streamId !== "string") {
        throw invalidGatewayResponse("streamRunEvents", undefined, subscribed);
      }
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

  /**
   * Streams run events with automatic reconnection. On an unexpected drop the
   * stream reconnects with exponential backoff + jitter and resumes from the
   * last per-run `seq` it observed, leaning on the gateway's `afterSeq` /
   * `run.gap_resync` replay semantics. Aborting the signal stops reconnection.
   *
   * An abrupt server drop surfaces as a WebSocket close (code 1006) with no
   * `error` event, so the inner stream ends *gracefully* rather than throwing.
   * We therefore reconnect whenever the inner stream ends without the run
   * reaching a terminal state (a `run.completed` frame) and without the abort
   * signal firing — treating a silent close exactly like a thrown drop. A clean
   * completion (run finished/failed/cancelled) or an aborted signal stops the
   * loop so we never spin on a legitimately-ended stream.
   *
   * Backoff only resets after a *sustained healthy* connection. A flapping
   * server that accepts the socket, replays a single frame (e.g. the
   * `run.gap_resync` catch-up frame), then instantly closes would otherwise
   * reset the attempt counter on that first frame and busy-reconnect at the base
   * delay forever. We therefore keep escalating backoff until the connection has
   * either stayed alive for `healthyAfterMs` or delivered a fresh (non-replay)
   * live frame — proof the stream is genuinely healthy rather than instantly
   * flapping.
   */
  async *streamRunEventsResilient(
    params: GatewayRpcParams<"streamRunEvents">,
    options: StreamRunEventsResilientOptions = {},
  ): AsyncGenerator<GatewayEventFrame<StreamRunEventPayload>> {
    const signal = options.signal;
    const healthyAfterMs = options.healthyAfterMs ?? 1_000;
    let lastSeq = typeof params.afterSeq === "number" ? params.afterSeq : undefined;
    let attempt = 0;
    while (!signal?.aborted) {
      let reachedTerminal = false;
      let reconnectReason: GatewayStreamReconnectEvent["reason"] = "stream_closed";
      let reconnectError: unknown;
      // Mark when this connection's inner stream began so we only zero the
      // backoff counter once the connection proves sustained liveness.
      const connectionStart = Date.now();
      let resetBackoff = false;
      try {
        for await (const frame of this.streamRunEvents(
          { runId: params.runId, ...(typeof lastSeq === "number" ? { afterSeq: lastSeq } : {}) },
          { signal },
        )) {
          const isReplay = isObject(frame.payload) && frame.payload.event === "run.gap_resync";
          // Reset backoff only after the connection is demonstrably healthy: a
          // live (non-replay) frame, or any frame past the healthy threshold.
          // A bare replay frame at connection start is NOT proof of liveness.
          if (!resetBackoff && (!isReplay || Date.now() - connectionStart >= healthyAfterMs)) {
            attempt = 0;
            resetBackoff = true;
          }
          const seq = isObject(frame.payload) && typeof frame.payload.seq === "number"
            ? frame.payload.seq
            : undefined;
          if (typeof seq === "number") {
            lastSeq = seq;
          }
          if (isObject(frame.payload) && frame.payload.event === "run.completed") {
            reachedTerminal = true;
          }
          yield frame;
        }
        // The inner stream ended without throwing. A graceful end is only a clean
        // stop when the run actually completed or the caller aborted; otherwise it
        // is a silent socket drop (close code 1006) and we reconnect + resume.
        if (reachedTerminal) {
          return;
        }
      } catch (error) {
        // A thrown drop (error frame, invalid frame, connect failure). Fall
        // through to the shared backoff + reconnect below unless aborted.
        reconnectReason = "transport_error";
        reconnectError = error;
      }
      // Either the stream threw or ended silently with the run still live. Stop
      // if the caller aborted; otherwise back off and reconnect (resuming from
      // the last observed seq).
      if (signal?.aborted) {
        return;
      }
      const backoffMs = gatewayBackoffDelay(attempt, options.backoff);
      options.onReconnect?.({
        runId: params.runId,
        ...(typeof lastSeq === "number" ? { afterSeq: lastSeq } : {}),
        attempt,
        backoffMs,
        reason: reconnectReason,
        ...(reconnectError === undefined ? {} : { error: reconnectError }),
      });
      await sleepWithSignal(backoffMs, signal);
      attempt += 1;
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

  /**
   * Invoke an extension resource or action over HTTP RPC. The wire method is
   * `ext.<namespace>.<key>`; the server-side `GatewayExtensions` registry
   * routes it to the matching handler. Stale-response guards are the caller's
   * job (signal-based abort) since this is a one-shot call; see
   * `useGatewayExtensionResource` for the React-side stale guard.
   */
  extensionRpc<T = unknown>(
    namespace: string,
    key: string,
    params: Record<string, unknown> = {},
    options: { signal?: AbortSignal } = {},
  ): Promise<T> {
    return this.rpcRaw(extensionMethodName(namespace, key), params, options) as Promise<T>;
  }

  /**
   * Subscribe to an extension stream. Returns an async iterable of payloads
   * filtered to the allocated `streamId`, so a stale subscriber re-using the
   * same connection cannot see frames intended for the new one. Resume after
   * a drop is the caller's responsibility — pass a fresh `params.afterSeq` (or
   * extension-specific cursor) when re-subscribing.
   *
   * Error frames from the gateway (`ext.stream.error`) throw, mirroring how
   * `streamRunEvents` surfaces `run.error`. A clean WS close ends the iterator
   * gracefully.
   *
   * If ElectricSQL Shapes are useful for the *read-source* under the hood, an
   * extension can adapt them inside its `subscribe()` handler (server-side)
   * and stream rows through `ctx.send`. The client API stays the same and
   * writes still flow through actions, never through the shape — see
   * https://electric-sql.com/docs/api/clients/typescript#shape for the upstream
   * model.
   */
  async *streamExtension<T = unknown>(
    namespace: string,
    key: string,
    params: Record<string, unknown> = {},
    options: { signal?: AbortSignal } = {},
  ): AsyncGenerator<T, void, void> {
    const connection = await this.connect({ signal: options.signal });
    const method = extensionStreamMethodName(namespace, key);
    try {
      const response = (await connection.requestRaw(method, params)) as
        | GatewayExtensionSubscribeResponse<T>
        | undefined;
      if (!isObject(response) || typeof response.streamId !== "string") {
        throw invalidGatewayResponse(method, undefined, response);
      }
      if (response.initial !== undefined) {
        yield response.initial as T;
      }
      for await (const frame of connection.events(options.signal)) {
        if (frame.event === GATEWAY_EXTENSION_STREAM_EVENT) {
          const payload = frame.payload as GatewayExtensionStreamFrame<T> | undefined;
          if (payload?.streamId === response.streamId) {
            yield payload.payload;
          }
          continue;
        }
        if (frame.event === GATEWAY_EXTENSION_STREAM_ERROR) {
          const errPayload = frame.payload as GatewayExtensionStreamErrorFrame | undefined;
          if (errPayload?.streamId === response.streamId) {
            throw new GatewayRpcError({
              method,
              code: errPayload.error.code,
              message: errPayload.error.message,
            });
          }
        }
      }
    } finally {
      connection.close();
    }
  }
}
