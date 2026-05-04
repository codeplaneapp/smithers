import type { GatewayRpcMethod } from "@smithers-orchestrator/gateway/rpc";
import { GatewayRpcError } from "./GatewayRpcError.ts";
import type { GatewayEventFrame } from "./GatewayEventFrame.ts";
import type { GatewayResponseFrame } from "./GatewayResponseFrame.ts";
import type { GatewayRpcParams, GatewayRpcPayload } from "./GatewayRpcTypeMap.ts";

type PendingRequest = {
  resolve: (payload: unknown) => void;
  reject: (error: Error) => void;
  method: string;
};

type QueuedEvent =
  | { kind: "event"; frame: GatewayEventFrame }
  | { kind: "error"; error: Error }
  | { kind: "close" };

function randomId(method: string) {
  const cryptoApi = globalThis.crypto;
  const suffix = typeof cryptoApi?.randomUUID === "function"
    ? cryptoApi.randomUUID()
    : Math.random().toString(36).slice(2);
  return `${method}-${suffix}`;
}

function frameError(frame: Extract<GatewayResponseFrame, { ok: false }>, method: string) {
  return new GatewayRpcError({
    method,
    code: frame.error.code,
    message: frame.error.message,
    requiredScope: frame.error.requiredScope,
    refresh: frame.error.refresh,
    details: frame.error.details,
  });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidFrameError(details?: unknown) {
  return new GatewayRpcError({
    method: "websocket",
    code: "INVALID_GATEWAY_RESPONSE",
    message: "Gateway returned an invalid WebSocket frame.",
    details,
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

function isGatewayEventFrame(value: unknown): value is GatewayEventFrame {
  return isObject(value) &&
    value.type === "event" &&
    typeof value.event === "string" &&
    typeof value.seq === "number" &&
    typeof value.stateVersion === "number";
}

export class SmithersGatewayConnection {
  readonly ws: WebSocket;
  readonly pending = new Map<string, PendingRequest>();
  readonly queue: QueuedEvent[] = [];
  readonly waiters: Array<() => void> = [];
  closed = false;

  constructor(ws: WebSocket) {
    this.ws = ws;
    ws.addEventListener("message", (message) => {
      this.handleMessage(message.data);
    });
    ws.addEventListener("error", () => {
      this.push({ kind: "error", error: new Error("Gateway WebSocket error") });
    });
    ws.addEventListener("close", () => {
      const alreadyClosed = this.closed;
      this.closed = true;
      this.rejectPending(new Error("Gateway WebSocket closed"));
      if (!alreadyClosed) {
        this.push({ kind: "close" });
      }
    });
  }

  request<Method extends GatewayRpcMethod>(
    method: Method,
    params: GatewayRpcParams<Method>,
  ): Promise<GatewayRpcPayload<Method>> {
    if (this.closed) {
      return Promise.reject(new Error("Gateway WebSocket is closed"));
    }
    const id = randomId(method);
    const frame = { type: "req", id, method, params };
    return new Promise((resolve, reject) => {
      this.pending.set(id, {
        method,
        resolve: (payload) => resolve(payload as GatewayRpcPayload<Method>),
        reject,
      });
      try {
        this.ws.send(JSON.stringify(frame));
      } catch (cause) {
        this.pending.delete(id);
        reject(cause instanceof Error ? cause : new Error(String(cause)));
      }
    });
  }

  requestRaw(method: string, params?: unknown): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(new Error("Gateway WebSocket is closed"));
    }
    const id = randomId(method);
    const frame = { type: "req", id, method, params };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { method, resolve, reject });
      try {
        this.ws.send(JSON.stringify(frame));
      } catch (cause) {
        this.pending.delete(id);
        reject(cause instanceof Error ? cause : new Error(String(cause)));
      }
    });
  }

  async *events(signal?: AbortSignal): AsyncGenerator<GatewayEventFrame> {
    const abort = () => this.close();
    if (signal?.aborted) {
      this.close();
      return;
    }
    signal?.addEventListener("abort", abort, { once: true });
    try {
      while (!this.closed || this.queue.length > 0) {
        const next = await this.shift();
        if (!next || next.kind === "close") {
          return;
        }
        if (next.kind === "error") {
          throw next.error;
        }
        yield next.frame;
      }
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  }

  close() {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.rejectPending(new Error("Gateway WebSocket closed"));
    this.push({ kind: "close" });
    this.ws.close();
  }

  private handleMessage(raw: unknown) {
    const text = typeof raw === "string" ? raw : String(raw);
    let frame: unknown;
    try {
      frame = JSON.parse(text);
    } catch {
      this.push({ kind: "error", error: invalidFrameError(text) });
      return;
    }
    if (isGatewayResponseFrame(frame)) {
      const pending = this.pending.get(frame.id);
      if (!pending) {
        return;
      }
      this.pending.delete(frame.id);
      if (frame.ok) {
        pending.resolve(frame.payload);
        return;
      }
      pending.reject(frameError(frame, pending.method));
      return;
    }
    if (isObject(frame) && frame.type === "res" && typeof frame.id === "string") {
      const pending = this.pending.get(frame.id);
      if (pending) {
        this.pending.delete(frame.id);
        pending.reject(invalidFrameError(frame));
      }
      return;
    }
    if (isGatewayEventFrame(frame)) {
      this.push({ kind: "event", frame });
      return;
    }
    this.push({ kind: "error", error: invalidFrameError(frame) });
  }

  private push(event: QueuedEvent) {
    this.queue.push(event);
    const waiters = this.waiters.splice(0);
    for (const waiter of waiters) {
      waiter();
    }
  }

  private async shift(): Promise<QueuedEvent | undefined> {
    while (this.queue.length === 0) {
      if (this.closed) {
        return { kind: "close" };
      }
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
      });
    }
    return this.queue.shift();
  }

  private rejectPending(error: Error) {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }
}
