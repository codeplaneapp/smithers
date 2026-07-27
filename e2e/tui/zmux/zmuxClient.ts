import type { Socket } from "bun";

export type ZmuxNotification = {
  method: string;
  params?: Record<string, unknown>;
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type ZmuxFrame = {
  jsonrpc?: string;
  id?: number | string | null;
  result?: unknown;
  error?: { code: number; message: string };
  method?: string;
  params?: Record<string, unknown>;
};

/**
 * A persistent client over zmuxd's unix socket: one `\n`-terminated JSON
 * object per line, no VT emulation. Responses carry `result`/`error` keyed by
 * the integer `id` the request sent; notifications (no `id`) broadcast to
 * every connection and are delivered through {@link notifications}. See
 * research/tui-parity/06-zmux-harness.md for the full protocol writeup.
 */
export class ZmuxClient {
  #socket: Socket<undefined> | null = null;
  #carry = "";
  #nextId = 1;
  #pending = new Map<number, PendingRequest>();
  #notificationListeners = new Set<(notification: ZmuxNotification) => void>();
  #ready: Promise<void>;
  #closed = false;

  constructor(socketPath: string) {
    let resolveReady!: () => void;
    let rejectReady!: (error: Error) => void;
    this.#ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    Bun.connect({
      unix: socketPath,
      socket: {
        open: (socket) => {
          this.#socket = socket;
          resolveReady();
        },
        // Bun delivers whatever the kernel hands back per event; we never
        // block this callback (incremental line splitter, no synchronous
        // work), which is what "read in chunks, never block the read loop"
        // (06-zmux-harness.md rule 6) requires of a well-behaved client.
        data: (_socket, chunk) => this.#onChunk(chunk),
        error: (_socket, error) => {
          rejectReady(error);
          this.#failAllPending(error);
        },
        close: () => {
          this.#closed = true;
          this.#failAllPending(new Error("zmux connection closed"));
        },
      },
    }).catch((error: unknown) => {
      rejectReady(error instanceof Error ? error : new Error(String(error)));
    });
  }

  async ready(): Promise<void> {
    await this.#ready;
  }

  #onChunk(chunk: Buffer): void {
    this.#carry += chunk.toString("utf8");
    let newlineIndex = this.#carry.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = this.#carry.slice(0, newlineIndex);
      this.#carry = this.#carry.slice(newlineIndex + 1);
      if (line.trim().length > 0) this.#onLine(line);
      newlineIndex = this.#carry.indexOf("\n");
    }
  }

  #onLine(line: string): void {
    let frame: ZmuxFrame;
    try {
      frame = JSON.parse(line) as ZmuxFrame;
    } catch {
      return;
    }
    if (typeof frame.id === "number" && this.#pending.has(frame.id)) {
      const pending = this.#pending.get(frame.id)!;
      this.#pending.delete(frame.id);
      clearTimeout(pending.timer);
      if (frame.error) {
        pending.reject(new Error(`${frame.error.message} (code ${frame.error.code})`));
      } else {
        pending.resolve(frame.result);
      }
      return;
    }
    if (typeof frame.method === "string") {
      const notification: ZmuxNotification = { method: frame.method, params: frame.params };
      for (const listener of this.#notificationListeners) listener(notification);
    }
  }

  #failAllPending(error: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }

  /** Send one request, `\r`-free single-line JSON, and resolve with `result` (or reject on `error`/timeout). */
  async request(method: string, params: Record<string, unknown> = {}, timeoutMs = 5000): Promise<any> {
    await this.ready();
    if (this.#closed || !this.#socket) throw new Error(`zmux socket not connected (request: ${method})`);
    const id = this.#nextId++;
    const line = `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`;
    const result = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`zmux request "${method}" timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
    });
    this.#socket.write(line);
    return result;
  }

  /** Subscribe to every broadcast notification (optionally filtered by method). Returns an unsubscribe function. */
  onNotification(listener: (notification: ZmuxNotification) => void, method?: string): () => void {
    const wrapped = method ? (n: ZmuxNotification) => n.method === method && listener(n) : listener;
    this.#notificationListeners.add(wrapped);
    return () => this.#notificationListeners.delete(wrapped);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    try {
      this.#socket?.end();
    } catch {
      /* socket already gone */
    }
  }
}
