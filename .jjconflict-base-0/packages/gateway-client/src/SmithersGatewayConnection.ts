import type { GatewayRpcMethod } from "@smithers-orchestrator/protocol/gateway-rpc";
import { isObject, isGatewayResponseFrame } from "./objectGuards.ts";
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
  | { kind: "event"; frame: GatewayEventFrame; bytes: number }
  | { kind: "error"; error: Error; bytes: number };

type ShiftedEvent = QueuedEvent | { kind: "close" };

export const GATEWAY_EVENT_BACKPRESSURE_CODE = "GATEWAY_EVENT_BACKPRESSURE";

export const DEFAULT_MAX_QUEUED_EVENTS = 10_000;
export const DEFAULT_MAX_QUEUED_EVENT_BYTES = 32 * 1024 * 1024;

export type SmithersGatewayConnectionOptions = {
  /** Max unconsumed queued events and errors before the connection closes with a backpressure error. */
  maxQueuedEvents?: number;
  /** Max total serialized bytes of unconsumed queued frames before the backpressure close. */
  maxQueuedEventBytes?: number;
};

function positiveLimit(value: number | undefined, fallback: number, name: string) {
  const limit = value ?? fallback;
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new RangeError(`${name} must be a positive safe integer.`);
  }
  return limit;
}

function serializedBytes(value: string) {
  return new TextEncoder().encode(value).byteLength;
}

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

function invalidFrameError(details?: unknown) {
  return new GatewayRpcError({
    method: "websocket",
    code: "INVALID_GATEWAY_RESPONSE",
    message: "Gateway returned an invalid WebSocket frame.",
    details,
  });
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
  readonly maxQueuedEvents: number;
  readonly maxQueuedEventBytes: number;
  closed = false;
  private eventConsumers = 0;
  private queuedEventBytes = 0;

  constructor(ws: WebSocket, options: SmithersGatewayConnectionOptions = {}) {
    this.ws = ws;
    this.maxQueuedEvents = positiveLimit(
      options.maxQueuedEvents,
      DEFAULT_MAX_QUEUED_EVENTS,
      "maxQueuedEvents",
    );
    this.maxQueuedEventBytes = positiveLimit(
      options.maxQueuedEventBytes,
      DEFAULT_MAX_QUEUED_EVENT_BYTES,
      "maxQueuedEventBytes",
    );
    ws.addEventListener("message", (message) => {
      this.handleMessage(message.data);
    });
    ws.addEventListener("error", () => {
      this.push({ kind: "error", error: new Error("Gateway WebSocket error"), bytes: 0 });
    });
    ws.addEventListener("close", () => {
      if (!this.closed) {
        this.finish(new Error("Gateway WebSocket closed"), false);
        this.clearTerminalQueueWhenUnobserved();
      }
    });
  }

  request<Method extends GatewayRpcMethod>(
    method: Method,
    params: GatewayRpcParams<Method>,
  ): Promise<GatewayRpcPayload<Method>> {
    return this.requestRaw(method, params) as Promise<GatewayRpcPayload<Method>>;
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
    this.eventConsumers += 1;
    try {
      if (signal?.aborted) {
        this.close();
        return;
      }
      signal?.addEventListener("abort", abort, { once: true });
      // Re-check the signal on both sides of the await so an abort that fires
      // while `shift()` is pending stops iteration without yielding a frame.
      while (!this.closed || this.queue.length > 0) {
        if (signal?.aborted) {
          return;
        }
        const next = await this.shift();
        if (signal?.aborted) {
          return;
        }
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
      this.eventConsumers -= 1;
      if (this.closed && this.eventConsumers === 0) {
        this.clearQueue();
      }
    }
  }

  close() {
    if (this.closed) {
      return;
    }
    this.finish(new Error("Gateway WebSocket closed"), this.eventConsumers === 0);
    this.ws.close();
  }

  private handleMessage(raw: unknown) {
    if (this.closed) {
      return;
    }
    const text = typeof raw === "string" ? raw : String(raw);
    let frame: unknown;
    try {
      frame = JSON.parse(text);
    } catch {
      this.push({ kind: "error", error: invalidFrameError(text), bytes: serializedBytes(text) });
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
      this.push({ kind: "event", frame, bytes: serializedBytes(text) });
      return;
    }
    this.push({ kind: "error", error: invalidFrameError(frame), bytes: serializedBytes(text) });
  }

  private push(event: QueuedEvent) {
    if (this.closed) {
      return;
    }
    if (
      this.queue.length + 1 > this.maxQueuedEvents ||
      this.queuedEventBytes + event.bytes > this.maxQueuedEventBytes
    ) {
      this.closeForBackpressure();
      return;
    }
    this.queue.push(event);
    this.queuedEventBytes += event.bytes;
    this.notifyWaiters();
  }

  private notifyWaiters() {
    const waiters = this.waiters.splice(0);
    for (const waiter of waiters) {
      waiter();
    }
  }

  private async shift(): Promise<ShiftedEvent | undefined> {
    while (this.queue.length === 0) {
      if (this.closed) {
        return { kind: "close" };
      }
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
      });
    }
    const event = this.queue.shift();
    if (event) {
      this.queuedEventBytes -= event.bytes;
    }
    return event;
  }

  private closeForBackpressure() {
    const error = new GatewayRpcError({
      method: "websocket",
      code: GATEWAY_EVENT_BACKPRESSURE_CODE,
      message: "Gateway WebSocket event queue exceeded its configured limits.",
      details: {
        maxQueuedEvents: this.maxQueuedEvents,
        maxQueuedEventBytes: this.maxQueuedEventBytes,
      },
    });
    this.finish(error, true);
    this.queue.push({ kind: "error", error, bytes: 0 });
    this.notifyWaiters();
    this.ws.close();
  }

  private finish(error: Error, clearQueue = this.eventConsumers === 0) {
    this.closed = true;
    this.rejectPending(error);
    if (clearQueue) {
      this.clearQueue();
    }
    this.notifyWaiters();
  }

  private clearQueue() {
    this.queue.length = 0;
    this.queuedEventBytes = 0;
  }

  private clearTerminalQueueWhenUnobserved() {
    setTimeout(() => {
      if (this.closed && this.eventConsumers === 0) {
        this.clearQueue();
      }
    }, 0);
  }

  private rejectPending(error: Error) {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }
}
