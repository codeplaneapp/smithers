import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { SmithersError } from "@smithers-orchestrator/errors/SmithersError";
import type { DevToolsDelta, DevToolsSnapshot } from "@smithers-orchestrator/protocol";

type RequestOptions = {
  baseUrl?: string;
  apiKey?: string;
  clientId?: string;
  clientVersion?: string;
};

type ResponseFrame = {
  type: "res";
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: {
    code?: string;
    message?: string;
  };
};

type EventFrame = {
  type: "event";
  event: string;
  payload?: unknown;
};

type DevToolsGapResync = {
  fromSeq: number;
  toSeq: number;
};

type DevToolsRuntimeEvent =
  | { version: 1; kind: "snapshot"; snapshot: DevToolsSnapshot & { runState?: RunStateView } }
  | { version: 1; kind: "delta"; delta: DevToolsDelta }
  | { version: 1; kind: "gapResync"; gapResync: DevToolsGapResync };

type RunStateView = {
  runId?: string;
  run_id?: string;
  state?: string;
  computedAt?: string;
  computed_at?: string;
  engineHeartbeatAtMs?: number;
  engine_heartbeat_at_ms?: number;
  engineHeartbeatMs?: number;
  engine_heartbeat_ms?: number;
  viewersHeartbeatAtMs?: number;
  viewers_heartbeat_at_ms?: number;
  uiHeartbeatAtMs?: number;
  ui_heartbeat_at_ms?: number;
  viewersHeartbeatMs?: number;
  viewers_heartbeat_ms?: number;
  uiHeartbeatMs?: number;
  ui_heartbeat_ms?: number;
  engineHeartbeatAt?: string;
  engine_heartbeat_at?: string;
  viewersHeartbeatAt?: string;
  viewers_heartbeat_at?: string;
  uiHeartbeatAt?: string;
  ui_heartbeat_at?: string;
  blocked?: unknown;
  unhealthy?: unknown;
};

type GatewayMutationResult = {
  auditRowId?: string;
};

type PendingRequest = {
  resolve: (frame: ResponseFrame) => void;
  reject: (error: Error) => void;
};

const DEFAULT_BASE = "http://127.0.0.1:7331";
const AUDIT_ROW_ID_KEYS = new Set([
  "auditRowId",
  "audit_row_id",
  "auditId",
  "audit_id",
  "auditLogId",
  "audit_log_id",
]);
const NESTED_AUDIT_CONTAINERS = ["result", "data", "mutation", "ack", "payload", "meta"];

function toWsUrl(baseUrl: string) {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = url.pathname === "/" ? "/" : url.pathname;
  url.search = "";
  return url.toString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function eventSeq(event: DevToolsRuntimeEvent) {
  switch (event.kind) {
    case "snapshot":
      return event.snapshot.seq;
    case "delta":
      return event.delta.seq;
    case "gapResync":
      return event.gapResync.toSeq;
  }
}

function normalizeEvent(raw: unknown): DevToolsRuntimeEvent {
  if (!isRecord(raw)) {
    throw new SmithersError("PI_DEVTOOLS_DECODE_ERROR", "DevTools event must be an object.");
  }
  const kind = typeof raw.kind === "string" ? raw.kind.toLowerCase() : undefined;
  const type = typeof raw.type === "string" ? raw.type.toLowerCase() : undefined;
  if (kind === "snapshot" && isRecord(raw.snapshot)) {
    return { version: 1, kind: "snapshot", snapshot: raw.snapshot as DevToolsSnapshot };
  }
  if (kind === "delta" && isRecord(raw.delta)) {
    return { version: 1, kind: "delta", delta: raw.delta as DevToolsDelta };
  }
  if ((kind === "gapresync" || kind === "gap_resync") && isRecord(raw.gapResync)) {
    return {
      version: 1,
      kind: "gapResync",
      gapResync: raw.gapResync as DevToolsGapResync,
    };
  }
  if (type === "snapshot") {
    return { version: 1, kind: "snapshot", snapshot: raw as DevToolsSnapshot };
  }
  if (type === "delta") {
    return { version: 1, kind: "delta", delta: raw as DevToolsDelta };
  }
  if (type === "gapresync" || type === "gap_resync") {
    return { version: 1, kind: "gapResync", gapResync: raw as DevToolsGapResync };
  }
  throw new SmithersError("PI_DEVTOOLS_DECODE_ERROR", "Unknown DevTools event kind.");
}

function unsupportedRpc(error: unknown) {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return [
    "method not found",
    "unknown method",
    "unsupported method",
    "not implemented",
    "unrecognized method",
    "not_found",
  ].some((phrase) => message.includes(phrase));
}

function auditRowId(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const id = auditRowId(entry);
      if (id) {
        return id;
      }
    }
    return undefined;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  for (const key of AUDIT_ROW_ID_KEYS) {
    const id = value[key];
    if (typeof id === "string" && id.length > 0) {
      return id;
    }
  }
  for (const key of NESTED_AUDIT_CONTAINERS) {
    const id = auditRowId(value[key]);
    if (id) {
      return id;
    }
  }
  return undefined;
}

class GatewayWsConnection {
  private readonly pending = new Map<string, PendingRequest>();
  private readonly messages: EventFrame[] = [];
  private readonly waiters: Array<(message: EventFrame | undefined) => void> = [];
  private closed = false;

  private constructor(private readonly ws: WebSocket) {
    ws.on("message", (raw) => this.handleMessage(raw));
    ws.on("close", () => this.closeWaiters());
    ws.on("error", (error) => this.rejectAll(error instanceof Error ? error : new Error(String(error))));
  }

  static async open(url: string) {
    const ws = new WebSocket(url);
    const connection = new GatewayWsConnection(ws);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    return connection;
  }

  async connect(params: Record<string, unknown>) {
    await this.waitForEvent("connect.challenge", 5_000);
    return this.request("connect", params);
  }

  request(method: string, params?: unknown) {
    const id = `${method}-${randomUUID()}`;
    const frame = { type: "req", id, method, params };
    return new Promise<ResponseFrame>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(frame), (error) => {
        if (error) {
          this.pending.delete(id);
          reject(error);
        }
      });
    });
  }

  async nextEvent() {
    if (this.messages.length > 0) {
      return this.messages.shift();
    }
    if (this.closed) {
      return undefined;
    }
    return new Promise<EventFrame | undefined>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  close() {
    this.closed = true;
    this.closeWaiters();
    if (this.ws.readyState === this.ws.OPEN || this.ws.readyState === this.ws.CONNECTING) {
      this.ws.close();
    }
  }

  private async waitForEvent(event: string, timeoutMs: number) {
    const timeoutAt = Date.now() + timeoutMs;
    while (Date.now() < timeoutAt) {
      const frame = await this.nextEvent();
      if (!frame) {
        break;
      }
      if (frame.event === event) {
        return frame;
      }
    }
    throw new SmithersError("PI_GATEWAY_TIMEOUT", `Timed out waiting for ${event}.`);
  }

  private handleMessage(raw: WebSocket.RawData) {
    let message: unknown;
    try {
      message = JSON.parse(String(raw));
    } catch (error) {
      this.rejectAll(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    if (!isRecord(message)) {
      return;
    }
    if (message.type === "res" && typeof message.id === "string") {
      const pending = this.pending.get(message.id);
      if (pending) {
        this.pending.delete(message.id);
        pending.resolve(message as ResponseFrame);
      }
      return;
    }
    if (message.type === "event" && typeof message.event === "string") {
      const frame = message as EventFrame;
      const waiter = this.waiters.shift();
      if (waiter) {
        waiter(frame);
      } else {
        this.messages.push(frame);
      }
    }
  }

  private rejectAll(error: Error) {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
    this.closeWaiters();
  }

  private closeWaiters() {
    this.closed = true;
    while (this.waiters.length > 0) {
      this.waiters.shift()?.(undefined);
    }
  }
}

export class DevToolsClient {
  readonly baseUrl: string;
  readonly apiKey: string | undefined;
  private readonly clientId: string;
  private readonly clientVersion: string;
  private readonly lastSeqSeenByRunId = new Map<string, number>();

  constructor(opts: RequestOptions = {}) {
    this.baseUrl = opts.baseUrl ?? DEFAULT_BASE;
    this.apiKey = opts.apiKey;
    this.clientId = opts.clientId ?? "smithers-pi-plugin";
    this.clientVersion = opts.clientVersion ?? "1.0.0";
  }

  lastSeqSeen(runId: string) {
    return this.lastSeqSeenByRunId.get(runId);
  }

  async *streamDevTools(
    runId: string,
    afterSeq?: number,
    signal?: AbortSignal,
  ): AsyncGenerator<DevToolsRuntimeEvent> {
    let afterSeqCursor = afterSeq ?? this.lastSeqSeenByRunId.get(runId);
    while (!signal?.aborted) {
      const connection = await GatewayWsConnection.open(toWsUrl(this.baseUrl));
      const abort = () => connection.close();
      signal?.addEventListener("abort", abort, { once: true });
      try {
        const hello = await connection.connect({
          minProtocol: 1,
          maxProtocol: 1,
          client: {
            id: this.clientId,
            version: this.clientVersion,
            platform: "pi",
          },
          auth: this.apiKey ? { token: this.apiKey } : undefined,
          subscribe: [runId],
        });
        this.assertOk(hello, "connect");

        const subscribed = await connection.request("streamDevTools", {
          runId,
          ...(typeof afterSeqCursor === "number" ? { afterSeq: afterSeqCursor } : {}),
        });
        if (!subscribed.ok) {
          const code = subscribed.error?.code;
          if (code === "SeqOutOfRange" && typeof afterSeqCursor === "number") {
            yield {
              version: 1,
              kind: "gapResync",
              gapResync: { fromSeq: afterSeqCursor, toSeq: afterSeqCursor },
            };
            afterSeqCursor = undefined;
            continue;
          }
          this.assertOk(subscribed, "streamDevTools");
        }

        const payload = isRecord(subscribed.payload) ? subscribed.payload : {};
        const streamId = typeof payload.streamId === "string" ? payload.streamId : undefined;
        while (!signal?.aborted) {
          const message = await connection.nextEvent();
          if (!message) {
            return;
          }
          if (message.event === "devtools.error" && isRecord(message.payload)) {
            if (!streamId || message.payload.streamId === streamId) {
              const error = isRecord(message.payload.error) ? message.payload.error : {};
              throw new SmithersError(
                String(error.code ?? "PI_DEVTOOLS_STREAM_ERROR"),
                String(error.message ?? "DevTools stream failed."),
                { runId, streamId },
              );
            }
          }
          if (message.event !== "devtools.event" || !isRecord(message.payload)) {
            continue;
          }
          if (streamId && message.payload.streamId !== streamId) {
            continue;
          }
          const event = normalizeEvent(message.payload.event);
          this.lastSeqSeenByRunId.set(
            runId,
            Math.max(this.lastSeqSeenByRunId.get(runId) ?? 0, eventSeq(event)),
          );
          yield event;
        }
      } finally {
        signal?.removeEventListener("abort", abort);
        connection.close();
      }
    }
  }

  async getDevToolsSnapshot(runId: string, frameNo?: number) {
    const snapshot = await this.rpc("getDevToolsSnapshot", {
      runId,
      ...(typeof frameNo === "number" ? { frameNo } : {}),
    });
    if (isRecord(snapshot) && typeof snapshot.seq === "number") {
      this.lastSeqSeenByRunId.set(runId, Math.max(this.lastSeqSeenByRunId.get(runId) ?? 0, snapshot.seq));
    }
    return snapshot as DevToolsSnapshot & { runState?: RunStateView };
  }

  async getNodeOutput(runId: string, nodeId: string, iteration?: number) {
    return this.rpc("devtools.getNodeOutput", {
      runId,
      nodeId,
      ...(typeof iteration === "number" ? { iteration } : {}),
    });
  }

  async getNodeDiff(runId: string, nodeId: string, iteration?: number) {
    return this.rpc("devtools.getNodeDiff", {
      runId,
      nodeId,
      ...(typeof iteration === "number" ? { iteration } : {}),
    });
  }

  async approve(runId: string, nodeId: string, iteration = 0, note?: string) {
    const payload = await this.rpc("approvals.decide", {
      runId,
      nodeId,
      iteration,
      approved: true,
      note,
    });
    return { auditRowId: auditRowId(payload) } satisfies GatewayMutationResult;
  }

  async deny(runId: string, nodeId: string, iteration = 0, note?: string) {
    const payload = await this.rpc("approvals.decide", {
      runId,
      nodeId,
      iteration,
      approved: false,
      note,
    });
    return { auditRowId: auditRowId(payload) } satisfies GatewayMutationResult;
  }

  async signal(runId: string, signal: string, payload?: unknown, correlationId?: string) {
    const response = await this.rpc("signals.send", {
      runId,
      signalName: signal,
      data: payload ?? {},
      correlationId,
    });
    return { auditRowId: auditRowId(response) } satisfies GatewayMutationResult;
  }

  async cancel(runId: string) {
    const payload = await this.rpc("runs.cancel", { runId });
    return { auditRowId: auditRowId(payload) } satisfies GatewayMutationResult;
  }

  async resume(runId: string) {
    return this.performMutation(["runs.resume", "workflowRuns.resume"], { runId });
  }

  async rewind(runId: string, frameNo: number, confirm = true) {
    const payload = await this.rpc("devtools.jumpToFrame", { runId, frameNo, confirm });
    return {
      ...(isRecord(payload) ? payload : {}),
      auditRowId: auditRowId(payload),
    };
  }

  private async performMutation(methods: string[], params: Record<string, unknown>) {
    let lastUnsupportedError: unknown;
    for (const method of methods) {
      try {
        const payload = await this.rpc(method, params);
        return { auditRowId: auditRowId(payload) } satisfies GatewayMutationResult;
      } catch (error) {
        if (unsupportedRpc(error)) {
          lastUnsupportedError = error;
          continue;
        }
        throw error;
      }
    }
    throw lastUnsupportedError instanceof Error
      ? lastUnsupportedError
      : new SmithersError("PI_UNSUPPORTED_MUTATION", "No supported gateway mutation RPC found.");
  }

  private async rpc(method: string, params?: unknown) {
    const id = `${method}-${randomUUID()}`;
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.apiKey) {
      headers.Authorization = `Bearer ${this.apiKey}`;
    }
    const response = await fetch(`${this.baseUrl}/rpc`, {
      method: "POST",
      headers,
      body: JSON.stringify({ type: "req", id, method, params }),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new SmithersError("PI_GATEWAY_HTTP_ERROR", `Gateway HTTP ${response.status}: ${text}`, {
        method,
        status: response.status,
      });
    }
    const frame = (await response.json()) as ResponseFrame;
    this.assertOk(frame, method);
    return frame.payload;
  }

  private assertOk(frame: ResponseFrame, method: string): asserts frame is ResponseFrame & { ok: true } {
    if (frame.ok) {
      return;
    }
    throw new SmithersError(
      String(frame.error?.code ?? "PI_GATEWAY_RPC_ERROR"),
      frame.error?.message ?? `${method} failed.`,
      { method },
    );
  }
}
